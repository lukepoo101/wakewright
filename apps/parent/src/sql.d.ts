// SQL files are imported as text (`with { type: "text" }`) and bundled.
declare module "*.sql" {
  const text: string;
  export default text;
}
