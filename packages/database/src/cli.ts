// `pnpm db:migrate` and `pnpm db:seed`. Both connect with DATABASE_ADMIN_URL,
// the role that owns the schema; the apps never use it.
import {
  DEV_CUSTOMER_ID,
  DEV_EXCHANGE_ACCOUNT_ID,
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_PASSWORD,
} from "./dev-seed";
import { createDatabase } from "./index";
import { migrate } from "./migrate";
import {
  allowDevelopmentSignIn,
  createDevelopmentLogin,
  seedDevelopment,
  verifyAppConnection,
} from "./seed";

function required(name: string) {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Set ${name} in .env. See .env.example and docs/database.md.`,
    );
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (args.length || (command !== "migrate" && command !== "seed"))
    throw new Error("Usage: cli.ts migrate|seed");
  const admin = createDatabase(required("DATABASE_ADMIN_URL"), { max: 1 });
  try {
    if (command === "migrate") {
      const { applied, unknown } = await migrate(admin);
      console.info(
        applied.length
          ? `Applied ${applied.join(", ")}.`
          : "The database is up to date.",
      );
      if (unknown.length)
        console.warn(
          `Applied before but missing from this checkout, perhaps from another branch: ${unknown.join(", ")}.`,
        );
      return;
    }
    if (process.env.NODE_ENV === "production")
      throw new Error("The development seed never runs in production.");
    const appUrl = required("DATABASE_URL");
    const login = await createDevelopmentLogin(admin, appUrl);
    if (login)
      console.info(`Created the login role ${login} for DATABASE_URL.`);
    if (await allowDevelopmentSignIn(admin, appUrl))
      console.info("Let DATABASE_URL's login role use the sign-in tables.");
    await seedDevelopment(admin);
    await verifyAppConnection(appUrl);
    console.info(
      `Seeded the dev customer ${DEV_CUSTOMER_ID} and their Binance Spot Testnet exchange account ${DEV_EXCHANGE_ACCOUNT_ID}. Sign in to the web app as ${DEV_LOGIN_EMAIL} with the password ${DEV_LOGIN_PASSWORD}.`,
    );
  } finally {
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
