// The dashboard package version, filled in by vite.config.ts.
declare const __APP_VERSION__: string;

// Vite turns an imported image into its served URL.
declare module "*.png" {
  const src: string;
  export default src;
}
