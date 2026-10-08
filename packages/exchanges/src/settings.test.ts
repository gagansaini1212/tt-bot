import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangeKeysRequestSchema, parseWebhookUrl } from "./settings.js";

const discordToken =
  "Zx9_yW8-vU7tS6rQ5pO4nM3lK2jI1hG0fE9dC8bA7zY6xW5vU4tS3rQ2pO1nM0lKa1b2";
const discord = `https://discord.com/api/webhooks/123456789012345678/${discordToken}`;
const telegramToken = "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345";
const telegram = `https://api.telegram.org/bot${telegramToken}/sendMessage?chat_id=-1001234567890`;

test("accepts Discord webhook URLs and shows only the token's last four characters", () => {
  for (const url of [
    discord,
    discord.replace("discord.com", "discordapp.com"),
    discord.replace("discord.com", "canary.discord.com"),
    discord.replace("/api/", "/api/v10/"),
    `${discord}?thread_id=987654321098765432`,
    `  ${discord}  `,
  ]) {
    const parsed = parseWebhookUrl(url);
    assert.ok(parsed.ok, url);
    assert.equal(parsed.kind, "discord");
    assert.equal(parsed.last4, "a1b2");
  }
});

test("accepts Telegram sendMessage URLs with a chat ID", () => {
  for (const url of [
    telegram,
    telegram.replace("-1001234567890", "@alerts_channel"),
    `${telegram}&message_thread_id=42`,
  ]) {
    const parsed = parseWebhookUrl(url);
    assert.ok(parsed.ok, url);
    assert.equal(parsed.kind, "telegram");
    assert.equal(parsed.last4, "2345");
  }
});

test("refuses every other URL, without echoing it", () => {
  for (const url of [
    "",
    "not a url",
    discord.replace("https:", "http:"),
    discord.replace("discord.com", "discord.com:8443"),
    discord.replace("discord.com", "evil.example"),
    discord.replace("discord.com", "discord.com.evil.example"),
    discord.replace("https://", "https://user:pass@"),
    `${discord}#fragment`,
    `${discord}?wait=true`,
    `${discord}/slack`,
    discord.replace("/webhooks/", "/channels/"),
    "https://127.0.0.1/api/webhooks/123456789012345678/token",
    "https://169.254.169.254/latest/meta-data",
    telegram.replace("sendMessage", "getUpdates"),
    telegram.replace("?chat_id=-1001234567890", ""),
    `${telegram}&chat_id=1`,
    `${telegram}&parse_mode=HTML`,
    telegram.replace("-1001234567890", "1; drop"),
    `${discord}${"a".repeat(600)}`,
  ]) {
    const parsed = parseWebhookUrl(url);
    assert.equal(parsed.ok, false, url);
    if (!parsed.ok && url.length > 20) {
      assert.doesNotMatch(parsed.message, new RegExp(discordToken));
      assert.doesNotMatch(parsed.message, new RegExp(telegramToken));
    }
  }
});

test("exchange keys are an HMAC secret or a PEM private key, never both", () => {
  const apiKey =
    "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A";
  assert.ok(
    exchangeKeysRequestSchema.safeParse({
      kind: "hmac",
      apiKey,
      secretKey:
        "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j",
    }).success,
  );
  assert.ok(
    exchangeKeysRequestSchema.safeParse({
      kind: "private_key",
      apiKey,
      privateKey: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----\n`,
    }).success,
  );
  for (const request of [
    { kind: "hmac", apiKey, secretKey: "short" },
    { kind: "hmac", apiKey, secretKey: "has spaces in the secret key" },
    { kind: "hmac", apiKey: "short", secretKey: "x".repeat(32) },
    { kind: "private_key", apiKey, privateKey: "x".repeat(100) },
    {
      kind: "hmac",
      apiKey,
      secretKey: "x".repeat(32),
      privateKey: "-----BEGIN",
    },
  ])
    assert.equal(
      exchangeKeysRequestSchema.safeParse(request).success,
      false,
      JSON.stringify(request),
    );
});
