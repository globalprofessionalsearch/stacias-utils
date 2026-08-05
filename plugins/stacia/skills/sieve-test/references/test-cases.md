# Sieve Test Cases

Each test lists the command, the expected resolution, whether the summarizer
should produce output, and the expected per-script outcomes.

Outcome key: `S` = skip, `A` = approved, `U` = uncertain, `D` = denied

## Setup

Before running tests, ensure a file exists at `~/Documents/code/sieve-test.txt`
with any content. Create it if missing:

```bash
echo "hello" > ~/Documents/code/sieve-test.txt
```

---

## Test 1: Read — allowed directory

**Command:**
```
Read the file at ~/Documents/code/sieve-test.txt
```

**Expected:** resolution `approved`, no prompt

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | A |
| allow-safe-mutations | S |
| allow-safe-bash | S |

---

## Test 2: Read — sensitive path

**Command:**
```
Read the file at ~/.ssh/config
```

**Expected:** resolution `uncertain`, user prompted, summarizer message shown

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | U |
| guard-external-dirs | S |
| allow-readonly | A |
| allow-safe-mutations | S |
| allow-safe-bash | S |

---

## Test 3: Read — external path (non-sensitive)

**Command:**
```
Read the file at /etc/hosts
```

**Expected:** resolution `approved`, no prompt (guard-external-dirs skips
for non-mutating tools)

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | A |
| allow-safe-mutations | S |
| allow-safe-bash | S |

---

## Test 4: Write — allowed directory

**Command:**
```
Write the text "sieve test" to ~/Documents/code/sieve-test-output.txt
```

**Expected:** resolution `approved`, no prompt

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | A |
| allow-safe-bash | S |

---

## Test 5: Write — outside allowed directories

**Command:**
```
Write the text "test" to /tmp/sieve-test.txt
```

**Expected:** resolution `uncertain`, user prompted, summarizer message

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | U |
| allow-safe-bash | S |

Note: guard-external-dirs skips (Write is mutating, but the guard now only
checks Write/Edit/NotebookEdit paths — and `/tmp` is outside the allowed
prefixes). allow-safe-mutations also returns U for the same reason. Either
one alone is sufficient to trigger the prompt.

---

## Test 6: Write — sensitive path

**Command:**
```
Write the text "test" to ~/.env
```

**Expected:** resolution `uncertain`, user prompted

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | U |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | U |
| allow-safe-bash | S |

---

## Test 7: Bash — safe command

**Command:**
```
Run: ls /tmp
```

**Expected:** resolution `approved`, no prompt

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | A |

---

## Test 8: Bash — safe git command

**Command:**
```
Run: git status
```

**Expected:** resolution `approved`, no prompt

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | A |

---

## Test 9: Bash — git push (carve-out)

**Command:**
```
Run: git push origin test-branch
```

**Expected:** resolution `uncertain`, user prompted

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | U |

Note: use a non-existent branch name to avoid actually pushing anything.

---

## Test 10: Bash — force push (hard deny)

**Command:**
```
Run: git push --force origin main
```

**Expected:** resolution `denied`, Claude told to use `--force-with-lease`

| Script | Outcome |
|--------|---------|
| deny-dangerous | D |
| (remaining scripts do not run — short-circuit) | |

---

## Test 11: Bash — terraform (hard deny)

**Command:**
```
Run: terraform plan
```

**Expected:** resolution `denied`, Claude told to use tofu instead

| Script | Outcome |
|--------|---------|
| deny-dangerous | D |
| (remaining scripts do not run — short-circuit) | |

---

## Test 12: Bash — rm -rf (carve-out)

**Command:**
```
Run: rm -rf /tmp/nonexistent-sieve-test-dir
```

**Expected:** resolution `uncertain`, user prompted, summarizer message

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | U |

---

## Test 13: Bash — rm without -rf (safe)

**Command:**
```
Run: rm /tmp/nonexistent-sieve-test-file
```

**Expected:** resolution `approved`, no prompt

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | A |

---

## Test 14: Bash — kubectl read-only

**Command:**
```
Run: kubectl get pods
```

**Expected:** resolution `approved`, no prompt (even if kubectl isn't
installed — the sieve approves the command before execution)

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | A |

---

## Test 15: Bash — sensitive path in command

**Command:**
```
Run: cat ~/.aws/credentials
```

**Expected:** resolution `uncertain`, user prompted

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | U |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | A |

Note: allow-safe-bash approves `cat`, but guard-sensitive-paths catches the
sensitive path and poisons the resolution.

---

## Test 16: Bash — gh pr merge (hard deny)

**Command:**
```
Run: gh pr merge 123
```

**Expected:** resolution `denied`, Claude told to use the GitHub UI

| Script | Outcome |
|--------|---------|
| deny-dangerous | D |
| (remaining scripts do not run — short-circuit) | |

---

## Test 17: Bash — unknown command

**Command:**
```
Run: some-unknown-command --flag
```

**Expected:** resolution `uncertain`, user prompted (allow-safe-bash
doesn't recognize the command)

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | U |

---

## Test 18: Bash — safe compound command

**Command:**
```
Run: ls /tmp && grep test /etc/hosts
```

**Expected:** aggregate resolution `approved`, no prompt (both segments
are safe)

The dispatcher splits this into two segments and evaluates each through
the full pipeline independently:

**Segment 1:** `ls /tmp`

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | A |

Segment resolution: `approved`

**Segment 2:** `grep test /etc/hosts`

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | A |

Segment resolution: `approved`

**Aggregate:** all segments approved → `approved`

---

## Test 19: Bash — compound with unsafe segment

**Command:**
```
Run: ls /tmp && rm -rf /tmp/fake
```

**Expected:** aggregate resolution `uncertain`, user prompted (rm -rf
segment triggers the carve-out)

The dispatcher splits this into two segments:

**Segment 1:** `ls /tmp`

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-sensitive-paths | A |
| guard-external-dirs | S |
| allow-readonly | S |
| allow-safe-mutations | S |
| allow-safe-bash | A |

Segment resolution: `approved`

**Segment 2:** `rm -rf /tmp/fake`

| Script | Outcome |
|--------|---------|
| deny-dangerous | S |
| guard-bash-carveouts | U |
| (short-circuits to uncertain) | |

Segment resolution: `uncertain`

**Aggregate:** not all segments approved → `uncertain`
