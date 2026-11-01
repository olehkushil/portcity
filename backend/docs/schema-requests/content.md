# Запити модуля content до схеми

## content-1 (необов'язково): заборона перетину правил орендаря на рівні БД

- Файл і модель: `prisma/schema/content.prisma`, `TenantLoyaltyRule` (таблиця `tenant_loyalty_rules`).
- Пропонований фрагмент: Prisma не описує exclusion constraint, тому лише ручний SQL у міграції:

  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE tenant_loyalty_rules
    ADD CONSTRAINT tenant_loyalty_rules_no_overlap
    EXCLUDE USING gist (
      tenant_id WITH =,
      tstzrange(valid_from, valid_to, '[)') WITH &&
    );
  ```

- Причина: інваріант "періоди правил одного орендаря не перетинаються" зараз забезпечує застосунок
  (`assertNoRuleOverlap` під `SELECT ... FROM tenants ... FOR UPDATE`). Обмеження в БД захистить від
  ручних вставок і майбутніх імпортів. Сервіс уже мапить помилку перетину на `PC_TENANT_RULE_OVERLAP`
  на рівні застосунку; для порушення constraint потрібна буде мапа коду `23P01`.
- Вплив на міграцію: нових колонок немає; потрібне розширення `btree_gist` (є в образі `postgres:17`).
  Наявні дані мають не перетинатися (seed правил не створює).
- Статус: застосовано 2026-11-01 (integration): `btree_gist` + `tenant_loyalty_rules_no_overlap` у міграції `20261101120000_module_requests`; сервіс мапить SQLSTATE 23P01 на `PC_TENANT_RULE_OVERLAP`.

English summary: optional defence-in-depth EXCLUDE constraint (btree_gist) so loyalty rule periods of
one tenant cannot overlap even outside the service.
