// Supabase 연결 정보 (공개용 주소와 공개 키라서 앱에 들어가도 괜찮다)
// 데이터 보호는 supabase/schema.sql 의 보안 규칙이 맡는다.
// 절대 secret / service_role 키를 여기에 넣지 말 것.
export const SUPABASE_URL = 'https://vhxbwcuyjbyzaxsmdbct.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_TkFN5h4k_Wjccx-P-n_oXw_hUFLhwbV';

// 푸시 알림 공개 키 (짝이 되는 비밀 키는 supabase/secrets.local.txt 에만 있다)
export const VAPID_PUBLIC_KEY = 'BJZkAjg_vHDsOKzFJfYacUSW2IP6QIta_d3omTUhPZng-Q4v_iwDgbYu2AMdGY3PaUckxVJMAPxotTU_aRmebqw';
