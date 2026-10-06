import { composePush } from '@/supabase/functions/dispatch-notification/compose';
import * as fs from 'fs';
import * as path from 'path';

describe('founder_new_user push composition', () => {
  it('title "New user", body names the business only, deep link to the directory', () => {
    const p = composePush('founder_new_user', 'Chez Awa', { business_name: 'Chez Awa' }, 'biz-1');
    expect(p.title).toBe('New user');
    expect(p.body).toBe("Chez Awa vient d'arriver sur Patron.");
    expect(p.route).toBe('/(app)/founder-kpi/vendeurs');
    expect(p.data).toEqual({ route: '/(app)/founder-kpi/vendeurs', event_type: 'founder_new_user', business_id: 'biz-1' });
  });

  it('index.ts: cron-secret only, recipient is the founder only, name comes from the row', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/dispatch-notification/index.ts'), 'utf8');
    expect(src).toMatch(/event_type === 'founder_new_user' && !isCronCall/);
    expect(src).toMatch(/event_type === 'support_message' \|\| event_type === 'founder_new_user'[\s\S]{0,500}get_founder_id/);
    expect(src).toMatch(/payload = \{ business_name: bizName \}/);
    expect(src).toMatch(/CRON_EVENTS = new Set\([\s\S]*'founder_new_user'/);
  });
});
