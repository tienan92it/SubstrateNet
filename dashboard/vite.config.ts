import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Emit a single self-contained index.html (JS + CSS inlined) so the dashboard
// opens directly from disk (file://) with no server. The CodeGps CLI injects
// the graph snapshot into the inline data marker at generation time.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
  },
});
