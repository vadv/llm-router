import { Badge, Card, Code, Drawer, Modal, Table, createTheme, rem } from "@mantine/core";

// One quiet surface for dense data: near-black neutrals with hairline
// borders, a single brand teal, system type at 12–14px and tabular numbers.
// Panels are flat; depth comes from the surface ramp, never from shadows or
// gradients.
const DARK = [
  "#e6e8ec", // 0: text
  "#cfd3da", // 1: text, slightly softer
  "#8f95a0", // 2: dimmed
  "#5b616c", // 3: placeholder
  "#262930", // 4: border
  "#1c1f24", // 5: hover
  "#141619", // 6: surface
  "#0e0f12", // 7: page
  "#0a0b0d", // 8: sunken
  "#060708", // 9
] as const;

export const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "sm",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSizes: {
    xs: rem(12),
    sm: rem(13),
    md: rem(14),
    lg: rem(16),
    xl: rem(18),
  },
  lineHeights: {
    xs: "1.4",
    sm: "1.45",
    md: "1.5",
    lg: "1.4",
    xl: "1.35",
  },
  radius: {
    xs: "3px",
    sm: "6px",
    md: "10px",
    lg: "14px",
    xl: "20px",
  },
  // Only overlays carry a shadow, and a soft one.
  shadows: {
    xs: "0 1px 2px light-dark(rgba(20, 24, 30, 0.06), rgba(0, 0, 0, 0.3))",
    sm: "0 1px 3px light-dark(rgba(20, 24, 30, 0.08), rgba(0, 0, 0, 0.35))",
    md: "0 4px 14px light-dark(rgba(20, 24, 30, 0.1), rgba(0, 0, 0, 0.4))",
    lg: "0 10px 26px light-dark(rgba(20, 24, 30, 0.12), rgba(0, 0, 0, 0.45))",
    xl: "0 18px 44px light-dark(rgba(20, 24, 30, 0.16), rgba(0, 0, 0, 0.55))",
  },
  colors: { dark: DARK },
  headings: {
    fontWeight: "600",
    sizes: {
      h1: { fontSize: rem(20), lineHeight: "1.25", fontWeight: "650" },
      h2: { fontSize: rem(15), lineHeight: "1.35" },
      h3: { fontSize: rem(13), lineHeight: "1.4" },
    },
  },
  components: {
    Card: Card.extend({ defaultProps: { withBorder: true, radius: "md", padding: "sm" } }),
    Badge: Badge.extend({
      defaultProps: { variant: "light", radius: "xl", size: "sm", fw: 500 },
      styles: { root: { textTransform: "none", letterSpacing: 0 } },
    }),
    Table: Table.extend({
      defaultProps: {
        verticalSpacing: 6,
        horizontalSpacing: "sm",
        // A row highlights only where a click opens something; tables opt in.
        highlightOnHover: false,
        tabularNums: true,
      },
      styles: {
        th: {
          fontWeight: 500,
          color: "var(--mantine-color-dimmed)",
          fontSize: "var(--mantine-font-size-xs)",
          borderBottom: "1px solid var(--mantine-color-default-border)",
        },
        tr: { borderBottom: "1px solid var(--mantine-color-default-border)" },
      },
    }),
    Code: Code.extend({ defaultProps: { fz: "xs" } }),
    Modal: Modal.extend({
      defaultProps: {
        radius: "lg",
        overlayProps: { backgroundOpacity: 0.55, blur: 3 },
      },
    }),
    Drawer: Drawer.extend({
      defaultProps: {
        radius: "lg",
        overlayProps: { backgroundOpacity: 0.35, blur: 0 },
      },
    }),
  },
});
