import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import fs from "fs";

export async function loadSecretsToEnv(secretName: string) {
  const client = new SecretManagerServiceClient();

  const [version] = await client.accessSecretVersion({
    name: `projects/542126096811/secrets/${secretName}/versions/latest`,
  });

  const payload = version.payload?.data?.toString();
  if (!payload) throw new Error("Secret payload kosong");

  // masukkan ke process.env
  payload.split("\n").forEach((line) => {
    const [key, ...rest] = line.split("=");
    if (key) process.env[key.trim()] = rest.join("=").trim();
  });

  console.log(`✅ Secret "${secretName}" loaded to env`);
}
