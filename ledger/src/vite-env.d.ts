/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_MEDIA_WORKER_URL?: string
  readonly VITE_BACKUP_WORKER_URL?: string
}
interface ImportMeta { readonly env: ImportMetaEnv }

declare const __BUILD_ID__: string
