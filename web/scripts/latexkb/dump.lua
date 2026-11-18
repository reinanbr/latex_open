-- Dumps the control sequences defined at this point of a LuaLaTeX run, with
-- an argument signature when it can be read from the macro's meaning.
-- Used by gen.mjs (texdesk LaTeX knowledge base); KBFILE is set by the caller.
local CALL = { call = true, long_call = true, outer_call = true, long_outer_call = true }
local ZERO = { char_given = true, math_given = true, xmath_given = true, assign_int = true,
  assign_dimen = true, assign_glue = true, assign_mu_glue = true, assign_toks = true,
  char_num = true, math_char_num = true, letter = true, other_char = true }

-- ltcmd argument specification -> s/o/m letters ("?" = rest unknown).
local function from_xparse(sp)
  sp = sp:gsub("%b{}", "")
  local out, i = {}, 1
  while i <= #sp do
    local c = sp:sub(i, i)
    if c == "s" then out[#out + 1] = "s"
    elseif c == "t" then out[#out + 1] = "s"; i = i + 1
    elseif c == "o" or c == "O" then out[#out + 1] = "o"
    elseif c == "d" or c == "D" then
      if sp:sub(i + 1, i + 1) == "[" then out[#out + 1] = "o" else return table.concat(out) .. "?" end
      i = i + 2
    elseif c == "m" or c == "v" then out[#out + 1] = "m"
    elseif c == "r" or c == "R" then out[#out + 1] = "m"; i = i + 2
    elseif c == "b" then -- environment body
    elseif c == "+" or c == "!" or c == ">" or c == "=" or c == " " then
    else return table.concat(out) .. "?" end
    i = i + 1
  end
  return table.concat(out)
end

local function spec(name, depth)
  if depth > 5 or not token.is_defined(name) then return nil end
  local cmd = token.create(name).cmdname
  if ZERO[cmd] then return "" end
  if not CALL[cmd] then return nil end
  local m = token.get_meaning(name) or ""
  local params, body = m:match("^(.-)%->(.*)$")
  if not params then return nil end
  if params ~= "" then
    local n = 0
    for _ in params:gmatch("#%d") do n = n + 1 end
    local rest = params:gsub("#%d", "")
    if rest == "" then return string.rep("m", n) end
    if rest == "{" and params:sub(-1) == "{" then return string.rep("m", n + 1) end
    return nil
  end
  local inner = body:match("^\\protect \\([A-Za-z]+)  $")
  if inner then return spec(inner .. " ", depth + 1) end
  inner = body:match("^\\@protected@testopt \\[A-Za-z]+ \\\\([A-Za-z]+) ")
  if inner then
    local r = spec("\\" .. inner, depth + 1)
    return r and ("o" .. r) or "o?"
  end
  local x = body:match("^\\__cmd_start[%w_:]* {([^}]*)}")
  if x then return from_xparse(x) end
  if body:match("^\\@ifstar") or body:match("^\\@ifstar") then return "s?" end
  if body:match("^\\@ifnextchar %[") or body:match("^\\kernel@ifnextchar %[") then return "o?" end
  if body:match("^\\leavevmode \\@ifstar") then return "s?" end
  return nil
end

local prim = {}
for _, p in ipairs(tex.primitives()) do prim[p] = true end

local f = io.open(KBFILE, "w")
-- Files really read (\listfiles is on): \ver@x.sty alone is not proof, some
-- packages define it to block or emulate others.
for file in ((token.is_defined("@filelist") and token.get_macro("@filelist")) or ""):gmatch("[^,]+") do
  local name, ext = file:match("^%s*(.-)%.(%a+)%s*$")
  if ext == "sty" then f:write("@\tpackage\t", name, "\n") end
  if ext == "cls" then f:write("@\tclass\t", name, "\n") end
end
for _, name in ipairs(tex.hashtokens()) do
  if token.is_defined(name) then
    if name:match("^[A-Za-z]+%*?$") then
      local cmd = token.create(name).cmdname
      local s = spec(name, 0)
      f:write(name, "\t", cmd, "\t", s or "!", "\t", prim[name] and "p" or "", "\n")
    end
  end
end
f:close()
