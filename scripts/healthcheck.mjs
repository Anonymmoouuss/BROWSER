const services = [
  { name: "browser-backend", port: 3030, path: "/health" },
  { name: "scramjet", port: 3031, path: "/health" },
  { name: "face-auth", port: 3032, path: "/health" },
];
if (process.env.CHECK_APP !== "0") {
  services.push({ name: "app", port: 3000, path: "/api/health" });
}
if (process.env.CHECK_GATEWAY !== "0") {
  services.push({ name: "gateway", port: Number(process.env.GATEWAY_PORT ?? 8080), path: "/api/health" });
}
if (process.env.CHECK_WATCHDOG === "1") {
  services.push({ name: "watchdog", port: 3034, path: "/health" });
}

const wait = process.argv.includes("--wait");
const deadline = Date.now() + (wait ? Number(process.env.HEALTH_TIMEOUT_MS ?? 120_000) : 0);
let results;
do {
  results = await Promise.all(services.map(async (service) => {
    try {
      const response = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
        signal: AbortSignal.timeout(3000),
      });
      await response.arrayBuffer();
      return { ...service, healthy: response.ok };
    } catch {
      return { ...service, healthy: false };
    }
  }));
  if (results.every((service) => service.healthy) || Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
} while (true);

for (const service of results) {
  console.log(`${service.name} :${service.port}: ${service.healthy ? "healthy" : "UNHEALTHY"}`);
}
if (results.some((service) => !service.healthy)) process.exitCode = 1;