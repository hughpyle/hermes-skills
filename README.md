# Hermes Agent Skills

## Using this repo with Hermes

Add as a skill source:

```bash
hermes skills tap add hughpyle/hermes-skills
```

Then browse, search, or install skills with the Hermes skills hub.


## Layout

```
skills/<category>/<skill-name>/
  SKILL.md          # skill definition (frontmatter + instructions)
  scripts/          # bundled scripts referenced by the skill
  references/       # reference docs loaded on demand
  templates/        # reusable templates
```

