"""El dominio de Eventos.

Nace separado de `catalog`, que sigue siendo la lectura pública. Lo que vive
aquí son las reglas: estados, permisos, versiones, admisión y aforo.

La transición está escrita en `docs/Z_EVENTOS_ARQUITECTURA.md`. `Event` y
`EventRegistration` siguen declarados en `catalog.models` a propósito: moverlos
en el mismo commit obligaría a tocar quince módulos y a reescribir el historial
de importaciones sin ganar nada.
"""
