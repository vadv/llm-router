import { Badge, Card, Code, Table, createTheme, rem } from "@mantine/core";

// Compact visual language: tight spacing, tabular numbers, small headings,
// and an outlined card as the standard panel. Density over decoration.
export const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "sm",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  headings: {
    fontWeight: "600",
    sizes: {
      h1: { fontSize: rem(18), lineHeight: "1.3" },
      h2: { fontSize: rem(15), lineHeight: "1.35" },
      h3: { fontSize: rem(13), lineHeight: "1.4" },
    },
  },
  components: {
    Card: Card.extend({ defaultProps: { withBorder: true, radius: "sm", padding: "sm" } }),
    Badge: Badge.extend({ defaultProps: { variant: "light", radius: "sm", size: "sm" } }),
    Table: Table.extend({
      defaultProps: {
        verticalSpacing: 4,
        horizontalSpacing: "sm",
        highlightOnHover: true,
        tabularNums: true,
      },
    }),
    Code: Code.extend({ defaultProps: { fz: "xs" } }),
  },
});