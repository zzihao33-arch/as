-- CM-HUB: present the existing local BOL tool as part of Air Pickup Management.
-- This migration changes permission catalog labels/grouping only. It does not
-- bind local BOL records to air pickup orders or handover batches.

USE cmhub;

UPDATE warehouse_permissions
SET module_code = 'air_pickups',
    display_name = CASE permission_code
      WHEN 'bol.view' THEN '查看交仓凭证'
      WHEN 'bol.manage' THEN '创建和编辑交仓凭证'
      WHEN 'bol.delete' THEN '删除交仓凭证'
      WHEN 'bol.output' THEN '输出交仓凭证'
      ELSE display_name
    END
WHERE permission_code IN ('bol.view', 'bol.manage', 'bol.delete', 'bol.output');
