import { defineConfig, loadConfigFromEnv } from './src/compose/config.ts';

/**
 * Server config-as-code (the first of the two project files; the other is `bootstrap.ts`). This is the
 * SERVER wiring — db / port / secrets / storage / i18n / debug — NOT the content schema (content-types
 * are data in Postgres, modelled via the Builder).
 *
 * This project is env-driven, so it defaults to `loadConfigFromEnv()`. Override any field inline, e.g.:
 *   export default defineConfig({ ...loadConfigFromEnv(), server: { port: 8080 } });
 */
export default defineConfig(loadConfigFromEnv());
