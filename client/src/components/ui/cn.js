// Mínimo `cn()` para componer className condicionales sin sumar dependencias
// (no usamos `clsx` ni `class-variance-authority` — el costo de mantenimiento
// de las primitives no lo justifica).
export function cn(...parts) {
    return parts.flat().filter(Boolean).join(' ');
}
