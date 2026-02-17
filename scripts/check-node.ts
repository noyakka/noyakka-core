const version = process.versions.node || "";
const ok = /^18\./.test(version);
if (!ok) {
  console.error(`Node 18.x required. Detected ${version}`);
  process.exit(1);
}
