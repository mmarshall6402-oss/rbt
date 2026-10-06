/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_AUTH_MODE?: 'dev' | 'cognito';
  readonly VITE_COGNITO_AUTHORITY: string;
  readonly VITE_COGNITO_CLIENT_ID: string;
  readonly VITE_COGNITO_DOMAIN: string;
}
