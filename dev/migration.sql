-- 挤黑五游戏房间表
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  game_state JSONB NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- 索引：按过期时间清理
CREATE INDEX IF NOT EXISTS idx_rooms_expires_at ON rooms(expires_at);

-- 访问策略：允许匿名访问（房间号随机生成，实际安全靠不可猜测性）
-- 注意：这些策略需要在 Supabase 中通过 sites-management 工具应用

-- 允许匿名 SELECT
CREATE POLICY "Allow anonymous select" ON rooms
  FOR SELECT
  TO anon
  USING (true);

-- 允许匿名 INSERT（创建房间）
CREATE POLICY "Allow anonymous insert" ON rooms
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- 允许匿名 UPDATE（更新游戏状态）
CREATE POLICY "Allow anonymous update" ON rooms
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

-- 允许匿名 DELETE（清理过期房间）
CREATE POLICY "Allow anonymous delete" ON rooms
  FOR DELETE
  TO anon
  USING (true);
