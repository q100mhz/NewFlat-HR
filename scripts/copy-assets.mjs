// Копирует SQL-миграции в dist после компиляции TypeScript
import { cpSync } from 'node:fs';
cpSync('src/migrations', 'dist/migrations', { recursive: true });
