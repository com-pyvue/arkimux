const permissionPattern = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/;

export type Permission = string;

export function validatePermission(value: unknown, location = "Permission"): Permission {
  if (typeof value !== "string" || !permissionPattern.test(value)) {
    throw new Error(
      `${location} must start with an alphanumeric character and contain only alphanumerics, colon, dot, underscore, or hyphen.`,
    );
  }
  return value;
}

export function normalizePermissions(value: unknown, location = "Role.permissions"): Permission[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${location} must be a non-empty array.`);
  }
  const permissions = value.map((permission, index) => (
    validatePermission(permission, `${location}[${index}]`)
  ));
  return [...new Set(permissions)].sort((left, right) => left.localeCompare(right));
}
