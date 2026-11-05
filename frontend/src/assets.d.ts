// Vite turns an imported image into its served URL.
declare module "*.png" {
  const src: string;
  export default src;
}
