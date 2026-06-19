import { createClient } from '@absurd/sdk';

// Single shared SDK client instance.
// In dev, the relative '/api' base is handled by the Vite proxy (-> http://localhost:3000,
// stripping the /api prefix). In prod, VITE_API_URL can point at the real API origin.
const baseUrl = import.meta.env.VITE_API_URL ?? '/api';

export const api = createClient({ baseUrl });
