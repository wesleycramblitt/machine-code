---
name: clean-code
description: Use when changing code. Keep modules small, cohesive, and easy to change.
---

# Clean Code

Apply these when you change code. They are design constraints for the code you
touch, not a mandate to refactor the repository.

- **Single responsibility.** One reason to change per function, class, or module.
- **Open for extension, closed for modification.** Add behavior by composing
  new pieces; do not edit stable code for every variant.
- **Liskov substitution.** A subtype must honor the contract of its supertype.
- **Interface segregation.** Keep interfaces small and specific to their caller.
- **Dependency inversion.** Depend on abstractions at boundaries; keep volatile
  details behind them.

Also:

- Keep functions small and names concrete.
- Make side effects and failures explicit.
- Prefer composition over inheritance.
- Remove dead code only in the area you are already changing.
- Do not refactor, document, or improve code outside the issue.

The runner owns acceptance gates; the issue prompt is the definition of done.
