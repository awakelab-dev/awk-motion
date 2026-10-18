-- Búsqueda full-text en español sobre el texto de la locución (hito 3, ADR-027).
-- Prisma no gestiona extensiones, funciones ni triggers: no aparecen como drift en `prisma migrate`.
-- La columna "searchVector" y su índice GIN están en el esquema (Unsupported("tsvector")) y en la migración init.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() es STABLE; esta envoltura fija el diccionario para poder usarla igual al escribir y al buscar.
CREATE OR REPLACE FUNCTION wilox_search_text(t text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT to_tsvector('spanish', public.unaccent('public.unaccent'::regdictionary, coalesce(t, ''))) $$;

CREATE OR REPLACE FUNCTION wilox_search_query(q text) RETURNS tsquery
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT websearch_to_tsquery('spanish', public.unaccent('public.unaccent'::regdictionary, coalesce(q, ''))) $$;

CREATE OR REPLACE FUNCTION wilox_generation_search_trigger() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW."searchVector" := wilox_search_text(NEW."text");
  RETURN NEW;
END
$$;

CREATE TRIGGER "Generation_searchVector_trg"
  BEFORE INSERT OR UPDATE OF "text" ON "Generation"
  FOR EACH ROW EXECUTE FUNCTION wilox_generation_search_trigger();
