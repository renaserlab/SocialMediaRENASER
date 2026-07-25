-- Resenas (testimonios): las publica cualquiera, no solo la administracion.
--
-- Al crear la tabla se reservo la escritura a `public.is_admin()`, de modo que
-- la comunidad solo podia mirar. Ahora cada persona comparte las suyas.
--
-- Se abre el INSERT, pero NO en bloque: editar y borrar siguen limitados a lo
-- propio (`author_id = auth.uid()`), o la apertura dejaria a cualquiera
-- retocando las resenas de los demas. La administracion mantiene el paso franco
-- para poder moderar.
--
-- La condicion `author_id = auth.uid()` del INSERT ya estaba y se conserva: es
-- la que impide publicar firmando con el nombre de otra persona.
--
-- No se borra ni se modifica ninguna fila: solo cambian los permisos. Las
-- resenas ya publicadas siguen intactas.
--
-- El script es REPETIBLE: se puede ejecutar entero mas de una vez.

-- Publicar: cualquier cuenta con sesion, siempre a su propio nombre.
drop policy if exists testimonials_insert_admin on public.testimonials;
drop policy if exists testimonials_insert on public.testimonials;
create policy testimonials_insert on public.testimonials
  for insert to authenticated with check (author_id = auth.uid());

-- Editar: la persona que lo publico, o la administracion.
drop policy if exists testimonials_update_admin on public.testimonials;
drop policy if exists testimonials_update on public.testimonials;
create policy testimonials_update on public.testimonials
  for update to authenticated
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());

-- Borrar: mismo criterio.
drop policy if exists testimonials_delete_admin on public.testimonials;
drop policy if exists testimonials_delete on public.testimonials;
create policy testimonials_delete on public.testimonials
  for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

-- Listar las de un perfil concreto (su galeria) sin recorrer la tabla entera.
create index if not exists testimonials_author_idx
  on public.testimonials (author_id, created_at desc);

notify pgrst, 'reload schema';

-- Comprobacion final.
select
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'testimonials') as politicas,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'testimonials'
       and policyname = 'testimonials_insert') as insert_abierto,
  (select count(*) from public.testimonials) as resenas_conservadas;
-- Esperado: politicas = 4, insert_abierto = 1, y las resenas que ya hubiera.
