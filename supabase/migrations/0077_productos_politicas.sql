-- 0077 · La política de venta por jurisdicción, versionada y congelable.
--
-- AL APLICARLA, REINICIAR LA API. La puerta de esquema cachea tambien el «no»
-- en la memoria del proceso: sin reiniciar, las rutas siguen contestando 503
-- aunque las tablas ya esten.
--
-- SIN APLICAR. Requiere la 0070.
--
-- LA REGLA QUE ESTA TABLA EXISTE PARA IMPONER: SIN POLÍTICA APROBADA PARA LA
-- JURISDICCIÓN, NO SE VENDE. No es una preferencia de diseño: el blueprint lo
-- dice con estas palabras —«Si withdrawalDays es null, la venta se bloquea en
-- esa jurisdicción hasta aprobación legal»— y una tienda que cobra sin haber
-- publicado sus condiciones de desistimiento y devolución es una tienda que no
-- puede cumplirlas.
--
-- POR QUÉ NO SE REUTILIZA `event_policies` (0069). Aquella versiona políticas
-- de un EVENTO por tipo —elegibilidad, efecto sobre la entrada— y su ámbito es
-- el organizador. Esta versiona por PAÍS y por ENTIDAD VENDEDORA, y lo que
-- congela son plazos legales. Meterlas en la misma tabla obligaría a que una
-- columna significara dos cosas según la fila, que es como se pierde un plazo.
--
-- LA HUELLA NO ES DECORACIÓN. `terms_sha256` es la prueba de que el texto que
-- alguien aceptó es el que sigue guardado. Con el identificador se lee la
-- política entera; con la huella se demuestra que no se tocó por debajo. El
-- pedido guarda las dos.
--
-- NADA SE INVENTA. Los plazos, la moneda, la entidad y el texto los escribe una
-- persona al publicar. Esta migración NO SIEMBRA NINGUNA POLÍTICA: una fila de
-- ejemplo sería una política inventada, y con ella se podría vender.
--
-- LO QUE NO TRAE, Y ES DELIBERADO:
--
--   * NI IMPUESTOS, NI COSTE DE ENVÍO, NI PLAZO DE ENTREGA, NI COMISIÓN. No
--     están decididos. Una columna vacía invita a rellenarla con un cero, y un
--     cero en un impuesto es una afirmación fiscal.
--   * NINGUNA COBERTURA GEOGRÁFICA fina. `country_code` es la jurisdicción; a
--     qué regiones se envía es del transportista, que es de otro incremento.
--
-- ROLLBACK: `drop table public.product_policies`.

-- ------------------------------------------------------------------------- --
-- 1. La política
-- ------------------------------------------------------------------------- --
create table if not exists public.product_policies (
  id uuid primary key default gen_random_uuid(),

  -- ISO 3166-1 alfa-2, en mayúsculas. Es LA JURISDICCIÓN, y por eso es lo
  -- primero: el pedido pregunta por país antes que por cualquier otra cosa.
  country_code char(2) not null
    constraint product_policies_pais check (country_code ~ '^[A-Z]{2}$'),

  -- QUIÉN VENDE, con su nombre legal. Sin entidad no hay comprobante ni a quién
  -- reclamarle, y «Z» a secas no es una entidad.
  seller_entity text not null
    constraint product_policies_entidad
    check (length(trim(seller_entity)) between 2 and 200),

  -- LA VERSIÓN, por país. Publicar la siguiente no le cambia las reglas a quien
  -- ya compró: su pedido guarda cuál aceptó.
  version integer not null
    constraint product_policies_version check (version >= 1),

  -- LA ÚNICA MONEDA EN LA QUE SE PUEDE COBRAR EN ESE PAÍS. Un pedido cuya
  -- moneda no es esta no se crea: cobrar en una moneda que la política no
  -- contempla deja el comprobante sin respaldo.
  currency char(3) not null
    constraint product_policies_moneda check (currency ~ '^[A-Z]{3}$'),

  -- EL TEXTO ENTERO, tal y como se le enseña a quien compra, y su huella.
  terms text not null
    constraint product_policies_texto
    check (length(trim(terms)) >= 50),
  terms_sha256 text not null
    constraint product_policies_huella check (terms_sha256 ~ '^[0-9a-f]{64}$'),

  -- LOS PLAZOS DEL BLUEPRINT. Nulos mientras nadie los haya decidido, y NULO NO
  -- ES CERO: cero horas para reportar una incidencia sería no tener derecho a
  -- reportarla. Mientras `withdrawal_days` sea nulo, esta política NO PUEDE
  -- publicarse —lo impone el CHECK de más abajo— y por tanto no se vende.
  incident_report_hours integer
    constraint product_policies_incidencia
    check (incident_report_hours is null or incident_report_hours between 1 and 8760),
  return_shipment_days integer
    constraint product_policies_devolucion
    check (return_shipment_days is null or return_shipment_days between 1 and 365),
  withdrawal_days integer
    constraint product_policies_desistimiento
    check (withdrawal_days is null or withdrawal_days between 0 and 365),

  -- QUIÉN PAGA EL PORTE DE VUELTA. Nulos mientras no se decida; el catálogo no
  -- los enseña hasta que tienen valor, porque afirmar que lo paga alguien es
  -- una condición de venta.
  buyer_pays_return_for_remorse boolean,
  seller_pays_return_for_defect boolean,

  warranty_rules_url text
    constraint product_policies_garantia
    check (
      warranty_rules_url is null
      or warranty_rules_url ~ '^https://'
    ),

  status text not null default 'draft'
    constraint product_policies_estado
    check (status in ('draft', 'published', 'retired')),

  -- DESDE CUÁNDO RIGE. Una política publicada con fecha futura todavía no
  -- vende: existe, se puede revisar, y entra en vigor cuando toca.
  effective_at timestamptz,

  published_at timestamptz,
  -- SIN CLAVE AJENA, por lo mismo que en el historial de inventario: quién
  -- publicó una política es un hecho del pasado y sobrevive a la cuenta.
  published_by uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- UNA VERSIÓN POR PAÍS. Publicar dos veces la misma versión con textos
  -- distintos dejaría dos pedidos citando lo mismo y diciendo cosas distintas.
  constraint product_policies_una_version unique (country_code, version)
);

-- UNA POLÍTICA PUBLICADA ESTÁ COMPLETA. Este es el CHECK que hace de «sin
-- política aprobada no se vende» una regla de la base y no una costumbre del
-- servidor: publicarla exige fecha de vigencia, plazo de desistimiento decidido
-- y plazo para reportar una incidencia. Sin ellos se queda en borrador.
alter table public.product_policies
  drop constraint if exists product_policies_publicada_esta_completa;
alter table public.product_policies
  add constraint product_policies_publicada_esta_completa
  check (
    status <> 'published'
    or (
      effective_at is not null
      and published_at is not null
      and withdrawal_days is not null
      and incident_report_hours is not null
      and return_shipment_days is not null
      and buyer_pays_return_for_remorse is not null
      and seller_pays_return_for_defect is not null
    )
  );

-- LO QUE SE PREGUNTA EN CADA PEDIDO: la vigente de un país. Índice parcial
-- porque los borradores y las retiradas no se consultan por este camino.
create index if not exists product_policies_vigente
  on public.product_policies (country_code, effective_at desc, version desc)
  where status = 'published';

-- ------------------------------------------------------------------------- --
-- 2. RLS y permisos
-- ------------------------------------------------------------------------- --
-- Ninguna política y ningún permiso suelto, como el resto de Productos. El
-- texto de la política SE LEE por la API, que solo entrega las publicadas y
-- vigentes: un `select` directo devolvería también los borradores legales.
alter table public.product_policies enable row level security;
revoke all on public.product_policies from anon, authenticated;

-- ------------------------------------------------------------------------- --
-- 3. Verificación
-- ------------------------------------------------------------------------- --
do $$
declare
  permisos bigint;
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'product_policies'
  ) then
    raise exception 'La 0077 no dejó product_policies';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'product_policies_publicada_esta_completa'
  ) then
    raise exception 'La 0077 no dejó el CHECK que impide publicar a medias';
  end if;

  -- ESTA MIGRACIÓN NO INSERTA NINGUNA FILA, y no se comprueba aquí contando:
  -- al reejecutarla sobre una base donde ya se publicó una política de verdad,
  -- ese recuento la haría fallar. Que aplicar las migraciones desde cero deje
  -- cero políticas lo comprueba la suite, que sí sabe que la base está limpia.

  select count(*) into permisos
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name = 'product_policies'
     and grantee in ('anon', 'authenticated');
  if permisos > 0 then
    raise exception 'product_policies tiene % permisos sueltos', permisos;
  end if;
end;
$$;

notify pgrst, 'reload schema';
