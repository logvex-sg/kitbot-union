
INSERT INTO kits (id, name, description, enabled) VALUES
  ('starter', 'Starter Kit', 'Basic food and tools for a new player', TRUE),
  ('pvp', 'PvP Kit', 'Combat loadout', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kit_items (kit_id, item, count) VALUES
  ('starter', 'bread', 32),
  ('starter', 'iron_pickaxe', 1),
  ('starter', 'oak_log', 16),
  ('pvp', 'diamond_sword', 1),
  ('pvp', 'golden_apple', 8),
  ('pvp', 'diamond_chestplate', 1)
ON CONFLICT (kit_id, item) DO NOTHING;
