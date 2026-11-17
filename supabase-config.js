export const SUPABASE_CONFIG = {
  url: 'https://tsgpfthearuejylackke.supabase.co',
  anonKey: 'sb_publishable_4o1RfD9G6z_ZQ7K7I-0AGA_MwMrzQNL',
};

export const SUPABASE_MODULE_URL = 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const isSupabaseConfigured = (config) => Boolean(
  typeof config?.url === 'string'
  && config.url.startsWith('https://')
  && config.anonKey,
);
