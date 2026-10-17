import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const name = `restream-smoke-${randomUUID().slice(0, 12)}`;
const image = `${name}:test`;
const volume = `${name}-data`;
const containers = [`${name}-first`, `${name}-replacement`];
const providerSecret = "container-smoke-private-serial";
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => abort.abort());
}

async function docker(args, live = false) {
  const pending = exec("docker", args, {
    cwd: root,
    signal: abort.signal,
    timeout: live ? 15 * 60_000 : 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (live) {
    pending.child.stdout.pipe(process.stdout);
    pending.child.stderr.pipe(process.stderr);
  }
  return (await pending).stdout.trim();
}

function get(url, timeout = 5000) {
  return fetch(url, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]),
  });
}

async function healthy(base) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    try {
      const response = await get(`${base}/healthz`, 1000);
      if (response.ok && (await response.text()) === "ok\n") return;
    } catch {
      // The server may still be starting.
    }
    await delay(100, undefined, { signal: abort.signal });
  }
  throw new Error("Container did not become healthy within 20 seconds");
}

try {
  console.log("Building the production image for a container smoke test…");
  await docker(["build", "--target", "production", "-t", image, "."], true);
  await docker(["volume", "create", volume]);
  let databaseInode;

  for (const [index, container] of containers.entries()) {
    // The replacement also checks that runtime paths are independent of cwd.
    await docker([
      "run",
      "-d",
      "--name",
      container,
      ...(index === 1 ? ["--workdir", "/tmp"] : []),
      ...(index === 0 ? ["-e", `STALKER_SERIAL_NUMBER=${providerSecret}`] : []),
      "--mount",
      `type=volume,source=${volume},target=/data`,
      "-p",
      "127.0.0.1::8080",
      image,
    ]);
    const base = `http://${await docker(["port", container, "8080/tcp"])}`;
    await healthy(base);

    for (const path of ["/healthz", "/readyz"]) {
      const response = await get(base + path);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), "ok\n");
    }
    const statusResponse = await get(`${base}/api/status`);
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).configured, false);

    if (index === 0) {
      const saved = await fetch(`${base}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playback: { maxStreams: 2 } }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(saved.status, 200, "Application settings can be saved");
      assert.equal((await saved.json()).playback.maxStreams, 2);
    }
    const settings = await get(`${base}/api/settings`);
    assert.equal(settings.status, 200);
    const settingsBody = await settings.text();
    assert.ok(
      !settingsBody.includes(providerSecret),
      "Provider env values must remain private",
    );
    const configuration = JSON.parse(settingsBody);
    assert.equal(
      configuration.playback.maxStreams,
      2,
      "Application settings must survive container replacement",
    );
    assert.equal(
      configuration.provider.serialNumber,
      "",
      "Provider env values must not be exposed or copied into saved settings",
    );
    assert.deepEqual(
      configuration.providerEnvironment,
      index === 0 ? ["serialNumber"] : [],
    );
    if (index === 0) {
      const locked = await fetch(`${base}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: { serialNumber: "changed" } }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(
        locked.status,
        403,
        "Provider env fields cannot be edited through the API",
      );
      assert.equal((await locked.json()).code, "environment_managed");
    }

    const page = await get(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<div id="root"><\/div>/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)];
    assert.ok(assets.length > 0, "The image must include bundled UI assets");
    for (const [, path] of assets) {
      const asset = await get(base + path);
      assert.equal(asset.status, 200, path);
      assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
    }
    assert.notEqual(await docker(["exec", container, "id", "-u"]), "0");
    const inode = await docker([
      "exec",
      container,
      "stat",
      "-c",
      "%i",
      "/data/restream.sqlite",
    ]);

    if (index === 0) {
      databaseInode = inode;
      await docker([
        "exec",
        container,
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "/data/smoke.mp4",
      ]);
    } else {
      assert.equal(
        inode,
        databaseInode,
        "The database must survive replacement",
      );
    }
    const probe = JSON.parse(
      await docker([
        "exec",
        container,
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "json",
        "/data/smoke.mp4",
      ]),
    );
    assert.deepEqual(probe.streams.map((stream) => stream.codec_name).sort(), [
      "aac",
      "h264",
    ]);
    await docker([
      "exec",
      container,
      "ffmpeg",
      "-nostdin",
      "-v",
      "error",
      "-i",
      "/data/smoke.mp4",
      "-f",
      "null",
      "-",
    ]);
    await docker(["stop", "--time", "15", container]);
    assert.equal(
      await docker(["inspect", "--format", "{{.State.ExitCode}}", container]),
      "0",
    );
    await docker(["rm", container]);
  }
  console.log(
    "Container smoke test passed: UI, API, media tools, non-root startup, graceful shutdown, and persistent storage.",
  );
} catch (error) {
  console.error("Container smoke test failed:", error);
  for (const container of containers) {
    const logs = await exec("docker", ["logs", container], {
      timeout: 5000,
    }).catch(() => null);
    if (logs?.stdout || logs?.stderr) console.error(logs.stdout, logs.stderr);
  }
  process.exitCode = 1;
} finally {
  for (const container of containers) {
    await exec("docker", ["rm", "-f", container], { timeout: 15_000 }).catch(
      () => {},
    );
  }
  await exec("docker", ["volume", "rm", volume], { timeout: 15_000 }).catch(
    () => {},
  );
  await exec("docker", ["image", "rm", image], { timeout: 15_000 }).catch(
    () => {},
  );
}
