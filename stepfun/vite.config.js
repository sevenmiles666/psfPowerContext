import { defineConfig } from 'vite';
export default defineConfig({ publicDir: false, worker: { format: 'es' }, build: { target: 'es2022' } });
