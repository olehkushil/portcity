/**
 * Side-effect module imported FIRST by src/worker.ts.
 * The configuration is validated when AppModule is imported, so the mode must be set before that.
 */
process.env.APP_MODE = 'worker';
