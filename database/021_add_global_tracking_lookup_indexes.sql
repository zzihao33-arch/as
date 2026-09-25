-- Scan lookup spans clients, so client-prefixed indexes cannot serve it.
ALTER TABLE shipments
  ADD INDEX idx_shipments_first_leg_lookup (first_leg_tracking_no),
  ADD INDEX idx_shipments_courier_lookup (courier_tracking_no),
  ALGORITHM=INPLACE, LOCK=NONE;
