// CSS Modules are bundled by Bun; each import is a class name map.
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
