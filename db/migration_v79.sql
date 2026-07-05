-- v79: Allow vendeurs to see their own capital injections
CREATE POLICY "Vendeur: voir ses propres apports"
ON capital_injections FOR SELECT
TO authenticated
USING (
  get_role(business_id) = 'vendeur'
  AND injected_by_id = auth.uid()
);
