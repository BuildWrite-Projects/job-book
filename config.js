/* Job Book — connection settings.
   Same Supabase project as Field Measure ("BuildWrite Projects" organization).
   These two values are meant to be public. The publishable key can only do what
   the database's Row Level Security allows, which for Job Book is "members of
   the Job Book list, signed in, and nobody else". Never put a key labelled
   "secret" in this file. */
window.JB_CONFIG = {
  supabaseUrl: 'https://hnrwtrwatephqeifnbia.supabase.co',
  supabaseKey: 'sb_publishable_7EEnUfnh1z2OQ68F3GbEKA_cmyZ5WjP'
};
