import { DocumentType } from '@/types/documents';
import { isAgentToolAllowedByPolicy } from '@/lib/agora-ai/accessPolicy';
import type { AgentAccessPolicy, AgentToolDefinition } from '@/lib/agora-ai/types';
import { AGENT_UI_PANEL_DESCRIPTION, AGENT_UI_PANELS } from '@/lib/agora-ai/uiPanels';

export const AGORA_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: 'list_documents',
    description: 'Lista documentos del workspace actual. Default devuelve hasta 100 documentos por llamada (subible hasta 500 via limit). Si la respuesta incluye page.hasMore=true / page.nextCursor, hay más documentos: llama de nuevo pasando cursor=<nextCursor> para continuar. La respuesta incluye total con el conteo aproximado de la página.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Carpeta concreta a inspeccionar. Opcional.' },
        type: { type: 'string', enum: Object.values(DocumentType), description: 'Filtra por tipo de documento. Opcional.' },
        limit: { type: 'number', description: 'Máximo de items devueltos al modelo (post-filtro), entre 1 y 500. Default 100.' },
        pageSize: { type: 'number', description: 'Tamaño de la página de scan Firestore. Default 2000, máx 10000. Solo subir si necesitas escanear más por página.' },
        cursor: { type: 'string', description: 'Cursor opaco devuelto en page.nextCursor de una llamada previa para paginar. Pásalo para obtener la siguiente página.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'read_document',
    description: 'Lee y devuelve el contenido completo de un documento específico. Si pasas un nombre y hay varios documentos con ese nombre, devuelve { ambiguous: true, candidates: [...] } SIN error — elige el id correcto y vuelve a llamar.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Nombre o ID del documento a leer. Recomendado: ID Firestore exacto (20 chars).' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'create_document',
    description: 'Crea un documento nuevo de texto o carpeta dentro del workspace.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título del documento.' },
        content: { type: 'string', description: 'Contenido del documento. Para carpetas puede omitirse.' },
        folder: { type: 'string', description: 'Carpeta donde crear el documento. Opcional.' },
        type: { type: 'string', enum: [DocumentType.Text, DocumentType.Folder], description: 'Tipo de documento a crear.' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'update_document',
    description: 'Actualiza el contenido de un documento existente. Puede cambiar su título y/o contenido.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Nombre o ID del documento a actualizar.' },
        content: { type: 'string', description: 'Nuevo contenido en markdown.' },
        title: { type: 'string', description: 'Nuevo título (opcional).' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'rename_document',
    description: 'Renombra un documento existente sin cambiar su contenido. Parámetros obligatorios: documentId y newTitle.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Nombre actual o ID del documento a renombrar.' },
        newTitle: { type: 'string', description: 'Nuevo nombre/título para el documento.' }
      },
      required: ['documentId', 'newTitle'],
      additionalProperties: false
    }
  },
  {
    name: 'move_document',
    description: 'Mueve un documento a otra carpeta del workspace.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Nombre o ID del documento a mover.' },
        targetFolder: { type: 'string', description: 'Nombre de la carpeta destino.' }
      },
      required: ['documentId', 'targetFolder'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_document',
    description: 'Elimina un documento del workspace. Requiere confirmación explícita del usuario.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Nombre o ID del documento a eliminar.' },
        confirmed: { type: 'boolean', description: 'Solo true si el usuario confirmó la eliminación.' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'search_documents',
    description: 'Búsqueda lexical en NOMBRES, CARPETAS y CONTENIDO de documentos (texto exacto/substring, case-insensitive). Más rápido y barato que `search_workspace` cuando sólo te interesan docs. Úsala para keywords técnicos puntuales (e.g. "modus ponens", "tableau"). Para búsqueda híbrida grafo+lexical prefiere `find_related_via_graph`. Devuelve una página; itera page.nextCursor si page.hasMore=true.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de búsqueda.' },
        limit: { type: 'number', description: 'Máximo de matches devueltos al modelo, entre 1 y 25.' },
        pageSize: { type: 'number', description: 'Tamaño de la página de scan Firestore. Default 2000, máx 10000.' },
        cursor: { type: 'string', description: 'Cursor opaco devuelto en page.nextCursor para paginar.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'list_folders',
    description: 'Lista las CARPETAS del workspace. PRIMER PASO para preguntas sobre clases, lecciones o contenido académico. Las carpetas representan la estructura del curso (ej: Clase 1, Clase 2, etc.).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'create_folder',
    description: 'Crea una nueva carpeta lógica del workspace.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre de la carpeta.' },
        parentFolder: { type: 'string', description: 'Carpeta padre opcional.' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'get_workspace_info',
    description: 'Obtiene información del workspace actual, miembros y metadatos principales.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'inspect_workspace',
    description: 'Inventario estructural del workspace: carpetas (con conteos), documentos (sin contenido), snippets, tablero, semántico, worker (opcional). Es el PRIMER paso obligatorio para auditorías generales ("dame un overview"), antes de decidir qué leer en detalle. NO trae contenidos completos — para eso usa `read_workspace_bundle` después. Procesa una página por llamada; itera page.nextCursor.',
    parameters: {
      type: 'object',
      properties: {
        includeWorker: { type: 'boolean', description: 'Si true, consulta el Hub para saber si hay worker conectado.' },
        limit: { type: 'number', description: 'Máximo de items mostrados por sección en la respuesta, entre 5 y 100.' },
        pageSize: { type: 'number', description: 'Tamaño de la página de scan Firestore. Default 2000, máx 10000.' },
        cursor: { type: 'string', description: 'Cursor opaco para continuar la paginación de documentos.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_workspace',
    description: 'Búsqueda lexical AMPLIA: documentos + snippets + conceptos semánticos + tarjetas Kanban en una sola llamada. Úsala cuando NO sepas dónde está la información (puede estar en cualquier capa) o el user pregunte "busca X" sin acotar tipo. Si sabes que sólo buscas docs, prefiere `search_documents` (más barato). Itera page.nextCursor.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de búsqueda.' },
        limit: { type: 'number', description: 'Máximo de resultados por sección, entre 1 y 25.' },
        pageSize: { type: 'number', description: 'Tamaño de la página de scan Firestore. Default 2000, máx 10000.' },
        cursor: { type: 'string', description: 'Cursor opaco para continuar la paginación de documentos.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'read_workspace_bundle',
    description: 'Lee un paquete de contexto pre-curado: varios docs (por ids/folder/query) + opcionalmente snippets + conceptos semánticos en UNA llamada. Úsala cuando ya sabes QUÉ leer (e.g. tras `inspect_workspace` o `expand_context`) y quieres traer todo en un viaje en vez de N `read_document`. Procesa una página si das folder/query; si das documentIds explícitos lee todos ellos directo. Itera page.nextCursor.',
    parameters: {
      type: 'object',
      properties: {
        documentIds: { type: 'array', items: { type: 'string' }, description: 'IDs o nombres de documentos concretos a leer.' },
        folder: { type: 'string', description: 'Carpeta a leer. Incluye subcarpetas.' },
        query: { type: 'string', description: 'Filtro de texto sobre nombre, carpeta o contenido.' },
        includeContent: { type: 'boolean', description: 'Si false, devuelve solo metadatos y previews.' },
        includeSnippets: { type: 'boolean', description: 'Incluye snippets del workspace.' },
        includeSemantic: { type: 'boolean', description: 'Incluye conceptos y relaciones semánticas.' },
        maxDocuments: { type: 'number', description: 'Máximo de documentos, entre 1 y 50.' },
        maxCharsPerDocument: { type: 'number', description: 'Máximo de caracteres por documento, entre 500 y 12000.' },
        pageSize: { type: 'number', description: 'Tamaño de la página de scan Firestore. Default 2000, máx 10000.' },
        cursor: { type: 'string', description: 'Cursor opaco para continuar paginación.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_worker_status',
    description: 'Consulta si hay worker/terminal conectado para este workspace y lista sesiones activas conocidas por el Hub.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'run_worker_command',
    description: 'Ejecuta un comando shell dentro del worker del workspace sincronizado (/workspace). Requiere confirmación explícita. Úsala para inspeccionar archivos reales, correr tests, git status, scripts o comandos de proyecto cuando el worker esté online.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando shell a ejecutar dentro del worker.' },
        cwd: { type: 'string', description: 'Directorio relativo dentro de /workspace. Por defecto ".".' },
        timeoutMs: { type: 'number', description: 'Timeout entre 1000 y 25000 ms.' },
        maxOutputChars: { type: 'number', description: 'Máximo de caracteres de stdout/stderr devueltos, entre 1000 y 20000.' },
        expectChanges: { type: 'boolean', description: 'True si esperas que el comando modifique archivos sincronizados.' },
        reason: { type: 'string', description: 'Motivo breve para mostrar al usuario en la confirmación.' },
        confirmed: { type: 'boolean', description: 'Solo true después de confirmación explícita del usuario.' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    name: 'list_worker_files',
    description: 'Lista archivos y carpetas reales dentro del worker en /workspace usando un comando de solo lectura controlado. No requiere confirmación porque no acepta comandos arbitrarios.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa dentro de /workspace. Por defecto ".".' },
        maxDepth: { type: 'number', description: 'Profundidad máxima entre 1 y 6.' },
        limit: { type: 'number', description: 'Máximo de entradas entre 1 y 200.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'sync_status',
    description: 'Resume el estado de sincronización del workspace: documentos en Firestore, worker conectado y estado Git si Forgejo está disponible.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'git_status',
    description: 'Consulta el estado Git del workspace en Forgejo y lista documentos nuevos, modificados o limpios.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'git_log',
    description: 'Lee el historial de commits Git del workspace.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Número de commits a devolver, entre 1 y 50.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'git_commit_workspace',
    description: 'Crea un commit Git con documentos del workspace. Requiere confirmación explícita; si no se pasan documentIds, commitea documentos nuevos/modificados detectados por git_status.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Mensaje de commit.' },
        documentIds: { type: 'array', items: { type: 'string' }, description: 'IDs de documentos a commitear. Opcional.' },
        confirmed: { type: 'boolean', description: 'Solo true después de confirmación explícita del usuario.' }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'open_app_panel',
    description: `Pide a la interfaz abrir o enfocar un panel de la app: ${AGENT_UI_PANEL_DESCRIPTION}.`,
    parameters: {
      type: 'object',
      properties: {
        panel: {
          type: 'string',
          enum: [...AGENT_UI_PANELS],
          description: 'Panel a abrir.'
        },
        folder: { type: 'string', description: 'Carpeta a enfocar si panel=files. Opcional.' }
      },
      required: ['panel'],
      additionalProperties: false
    }
  },
  {
    name: 'report_debug',
    description: 'Publica una nota de debug del agente en el bus de Problemas para que el usuario vea fallos, advertencias o información operativa.',
    parameters: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['error', 'warning', 'info', 'hint'], description: 'Severidad del diagnóstico.' },
        message: { type: 'string', description: 'Mensaje corto visible.' },
        detail: { type: 'string', description: 'Detalle técnico opcional.' },
        code: { type: 'string', description: 'Código opcional del problema.' }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'get_semantic_state',
    description: 'Lee el estado semántico del workspace: conceptos, fragmentos y relaciones.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'list_snippets',
    description: 'Lista snippets reutilizables disponibles en el workspace actual.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'create_snippet',
    description: 'Crea un snippet reutilizable con markdown.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título del snippet.' },
        markdown: { type: 'string', description: 'Contenido markdown del snippet.' },
        description: { type: 'string', description: 'Descripción opcional.' },
        category: { type: 'string', description: 'Categoría opcional.' }
      },
      required: ['title', 'markdown'],
      additionalProperties: false
    }
  },
  {
    name: 'read_snippet',
    description: 'Lee un snippet por ID o título para revisar su contenido completo.',
    parameters: {
      type: 'object',
      properties: {
        snippetId: { type: 'string', description: 'ID o título del snippet.' }
      },
      required: ['snippetId'],
      additionalProperties: false
    }
  },
  {
    name: 'search_snippets',
    description: 'Busca snippets por título, categoría, descripción o contenido markdown.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de búsqueda.' },
        limit: { type: 'number', description: 'Máximo de resultados, entre 1 y 25.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'update_snippet',
    description: 'Actualiza un snippet existente.',
    parameters: {
      type: 'object',
      properties: {
        snippetId: { type: 'string', description: 'ID o título del snippet.' },
        title: { type: 'string', description: 'Nuevo título opcional.' },
        markdown: { type: 'string', description: 'Nuevo contenido markdown opcional.' },
        description: { type: 'string', description: 'Nueva descripción opcional.' },
        category: { type: 'string', description: 'Nueva categoría opcional.' },
        order: { type: 'number', description: 'Nuevo orden opcional.' }
      },
      required: ['snippetId'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_snippet',
    description: 'Elimina un snippet existente.',
    parameters: {
      type: 'object',
      properties: {
        snippetId: { type: 'string', description: 'ID o título del snippet.' }
      },
      required: ['snippetId'],
      additionalProperties: false
    }
  },
  {
    name: 'get_board',
    description: 'Recupera el tablero Kanban con columnas y tarjetas de TAREAS/PENDIENTES. NO contiene contenido de clases. Para contenido académico usa list_folders + list_documents.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'create_board_column',
    description: 'Crea una nueva columna en el tablero Kanban.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre de la columna.' },
        order: { type: 'number', description: 'Orden opcional de la columna.' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'rename_board_column',
    description: 'Renombra una columna del tablero Kanban.',
    parameters: {
      type: 'object',
      properties: {
        columnId: { type: 'string', description: 'ID o nombre de la columna.' },
        name: { type: 'string', description: 'Nuevo nombre.' }
      },
      required: ['columnId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_board_column',
    description: 'Elimina una columna del tablero y sus tarjetas. Requiere confirmación explícita.',
    parameters: {
      type: 'object',
      properties: {
        columnId: { type: 'string', description: 'ID o nombre de la columna.' },
        confirmed: { type: 'boolean', description: 'Solo true si el usuario confirmó la eliminación.' }
      },
      required: ['columnId'],
      additionalProperties: false
    }
  },
  {
    name: 'create_board_card',
    description: 'Crea una tarjeta nueva en una columna del tablero.',
    parameters: {
      type: 'object',
      properties: {
        columnId: { type: 'string', description: 'ID o nombre de la columna destino.' },
        title: { type: 'string', description: 'Título de la tarjeta.' },
        description: { type: 'string', description: 'Descripción opcional.' },
        sourceDocId: { type: 'string', description: 'Documento origen opcional.' },
        sourceDocName: { type: 'string', description: 'Nombre del documento origen opcional.' },
        sourceFragment: { type: 'string', description: 'Fragmento origen opcional.' },
        sourcePath: { type: 'string', description: 'Ruta origen opcional.' }
      },
      required: ['columnId', 'title'],
      additionalProperties: false
    }
  },
  {
    name: 'update_board_card',
    description: 'Actualiza el título, descripción o columna de una tarjeta del tablero.',
    parameters: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'ID o título de la tarjeta.' },
        title: { type: 'string', description: 'Nuevo título opcional.' },
        description: { type: 'string', description: 'Nueva descripción opcional.' },
        columnId: { type: 'string', description: 'ID o nombre de la nueva columna opcional.' },
        order: { type: 'number', description: 'Orden opcional dentro de la columna.' }
      },
      required: ['cardId'],
      additionalProperties: false
    }
  },
  {
    name: 'move_board_card',
    description: 'Mueve una tarjeta del tablero a otra columna.',
    parameters: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'ID o título de la tarjeta.' },
        targetColumnId: { type: 'string', description: 'ID o nombre de la columna destino.' },
        order: { type: 'number', description: 'Orden opcional en la columna destino.' }
      },
      required: ['cardId', 'targetColumnId'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_board_card',
    description: 'Elimina una tarjeta del tablero. Requiere confirmación explícita.',
    parameters: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'ID o título de la tarjeta.' },
        confirmed: { type: 'boolean', description: 'Solo true si el usuario confirmó la eliminación.' }
      },
      required: ['cardId'],
      additionalProperties: false
    }
  },
  {
    name: 'check_logic',
    description: 'Evalúa si una expresión o argumento lógico es válido. Recibe texto en lenguaje natural, lo formaliza automáticamente a código ST y lo ejecuta. Usa esta herramienta SIEMPRE que el usuario pregunte sobre validez, contradicciones, tautologías, silogismos o cualquier cuestión de lógica formal.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'La expresión, argumento o pregunta lógica en lenguaje natural.' },
        profile: { type: 'string', description: 'Perfil lógico opcional (classical.propositional, classical.fol, modal.K, etc.).' },
        language: { type: 'string', enum: ['es', 'en'], description: 'Idioma del texto.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'formalize_text',
    description: 'Formaliza texto natural a lógica usando el motor de formalización. Solo formaliza, no ejecuta. Si necesitas también ejecutar, usa check_logic.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Texto a formalizar.' },
        profile: { type: 'string', description: 'Perfil lógico, por ejemplo classical.propositional.' },
        language: { type: 'string', enum: ['es', 'en'], description: 'Idioma del texto.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'list_st_profiles',
    description: 'Lista los perfiles lógicos disponibles en ST.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'validate_st_syntax',
    description: 'Valida la sintaxis y diagnósticos de un programa ST sin ejecutarlo.',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'Código ST a validar.' }
      },
      required: ['program'],
      additionalProperties: false
    }
  },
  {
    name: 'run_st_program',
    description: 'Ejecuta un programa ST y devuelve su salida, diagnósticos y trazas.',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'Código ST a ejecutar.' }
      },
      required: ['program'],
      additionalProperties: false
    }
  },
  {
    name: 'render_st_glossary',
    description: 'Ejecuta un programa ST y devuelve el glosario activo de definiciones e interpretaciones.',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'Código ST base. Si no contiene glossary, se agrega automáticamente.' },
        format: { type: 'string', enum: ['plain', 'markdown'], description: 'Formato de salida opcional.' }
      },
      required: ['program'],
      additionalProperties: false
    }
  },
  {
    name: 'explain_formalization',
    description: 'Formaliza un texto y devuelve una explicación pedagógica del resultado.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Texto a formalizar.' },
        profile: { type: 'string', description: 'Perfil lógico deseado.' },
        language: { type: 'string', enum: ['es', 'en'], description: 'Idioma del texto.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'list_concepts',
    description: 'Lista CONCEPTOS del glosario semántico (definiciones teóricas, no carpetas de archivos).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filtro opcional por texto.' },
        limit: { type: 'number', description: 'Máximo de resultados, entre 1 y 50.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'define_concept',
    description: 'Crea o actualiza un concepto en el estado semántico / glosario del workspace.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Nombre del concepto.' },
        definition: { type: 'string', description: 'Definición del concepto.' },
        formula: { type: 'string', description: 'Fórmula lógica opcional.' },
        logicProfile: { type: 'string', description: 'Perfil lógico opcional.' },
        docName: { type: 'string', description: 'Nombre del documento fuente opcional.' },
        docId: { type: 'string', description: 'ID del documento fuente opcional.' },
        excerpt: { type: 'string', description: 'Fragmento fuente opcional.' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'create_relation',
    description: 'Crea una relación semántica entre dos conceptos del workspace.',
    parameters: {
      type: 'object',
      properties: {
        sourceConceptId: { type: 'string', description: 'ID o título del concepto origen.' },
        targetConceptId: { type: 'string', description: 'ID o título del concepto destino.' },
        relationType: {
          type: 'string',
          enum: ['supports', 'contradicts', 'implies', 'depends-on', 'defines', 'example-of', 'evidence-for', 'evidence-against', 'restates', 'questions', 'related-to'],
          description: 'Tipo de relación.'
        }
      },
      required: ['sourceConceptId', 'targetConceptId'],
      additionalProperties: false
    }
  },
  {
    name: 'update_concept',
    description: 'Edita un concepto existente del glosario semántico. Identifica por conceptId, id o title; aplica cambios parciales en title/definition/formula/logicProfile/status.',
    parameters: {
      type: 'object',
      properties: {
        conceptId: { type: 'string', description: 'ID del concepto a editar (preferido).' },
        id: { type: 'string', description: 'Alias de conceptId.' },
        title: { type: 'string', description: 'Si conceptId no se da, busca por título exacto. Si se da junto a conceptId, renombra.' },
        definition: { type: 'string' },
        formula: { type: 'string' },
        logicProfile: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'validated', 'archived'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'delete_concept',
    description: 'Elimina un concepto del glosario semántico y sus relaciones asociadas (cascada). Requiere confirmed:true en la segunda llamada.',
    parameters: {
      type: 'object',
      properties: {
        conceptId: { type: 'string', description: 'ID del concepto.' },
        id: { type: 'string', description: 'Alias de conceptId.' },
        title: { type: 'string', description: 'Alternativa: título exacto.' },
        confirmed: { type: 'boolean', description: 'Pasar true tras confirmar con el usuario.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'update_relation',
    description: 'Edita una relación semántica existente. Identifica por relationId; permite cambiar relationType y status.',
    parameters: {
      type: 'object',
      properties: {
        relationId: { type: 'string', description: 'ID de la relación.' },
        id: { type: 'string', description: 'Alias de relationId.' },
        relationType: {
          type: 'string',
          enum: ['supports', 'contradicts', 'implies', 'depends-on', 'defines', 'example-of', 'evidence-for', 'evidence-against', 'restates', 'questions', 'related-to']
        },
        status: { type: 'string', enum: ['draft', 'validated', 'archived'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'delete_relation',
    description: 'Elimina una relación semántica por relationId. Requiere confirmed:true en la segunda llamada.',
    parameters: {
      type: 'object',
      properties: {
        relationId: { type: 'string' },
        id: { type: 'string', description: 'Alias de relationId.' },
        confirmed: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'summarize_document',
    description: 'Genera un resumen extractivo de un documento existente.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'ID o título del documento.' },
        maxSentences: { type: 'number', description: 'Máximo de frases del resumen, entre 1 y 8.' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'compare_documents',
    description: 'Compara dos documentos y resume similitudes, diferencias y estructura compartida.',
    parameters: {
      type: 'object',
      properties: {
        leftDocumentId: { type: 'string', description: 'ID o título del documento izquierdo.' },
        rightDocumentId: { type: 'string', description: 'ID o título del documento derecho.' }
      },
      required: ['leftDocumentId', 'rightDocumentId'],
      additionalProperties: false
    }
  },
  {
    name: 'analyze_document',
    description: 'Analiza la estructura de un documento: headings, checklist, enlaces, fórmulas y métricas.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'ID o título del documento.' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'extract_pending_tasks',
    description: 'Extrae pendientes markdown de un documento y opcionalmente los convierte en tarjetas Kanban.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'ID o título del documento.' },
        createCards: { type: 'boolean', description: 'Si true, crea tarjetas en el tablero.' },
        targetColumnId: { type: 'string', description: 'ID o nombre de la columna destino opcional.' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'fetch_url',
    description: 'Descarga el contenido textual de una URL pública (http/https). Útil para consultar documentación externa, APIs públicas o recursos web. Bloquea localhost/IPs privadas. Devuelve {status, contentType, bodyText (truncado), bytesRead, truncated}. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL absoluta http(s)://... a descargar.' },
        maxBytes: { type: 'number', description: 'Bytes máximos a leer (1024..200000, default 50000).' },
        timeoutMs: { type: 'number', description: 'Timeout en ms (1000..30000, default 8000).' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'read_agora_doc',
    description: 'Lee la documentación oficial de Agora alojada en agora.elenxos.com/docs. Sin slug devuelve los slugs disponibles (ej. "st", "st/proposicional", "st/modal-k"). Con slug devuelve el contenido textual de esa doc. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug de la doc (ej. "st", "st/proposicional"). Vacío = lista los disponibles.' },
        maxBytes: { type: 'number', description: 'Bytes máximos a leer (default 80000).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'rename_folder',
    description: 'Renombra una carpeta en el workspace y actualiza el folder de TODOS los documentos hijos en cascada. Atómico via batch. Read-write.',
    parameters: {
      type: 'object',
      properties: {
        fromPath: { type: 'string', description: 'Path actual de la carpeta (ej. "Cursos/Filosofía").' },
        toName: { type: 'string', description: 'Nuevo nombre del último segmento (ej. "Lógica" para renombrar a "Cursos/Lógica").' }
      },
      required: ['fromPath', 'toName'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_folder',
    description: 'Elimina una carpeta. Si tiene hijos requiere cascade:true. Requiere confirmed:true. Destructivo.',
    parameters: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: 'Path completo de la carpeta a eliminar.' },
        cascade: { type: 'boolean', description: 'Si true, elimina también todos los documentos hijos.' },
        confirmed: { type: 'boolean', description: 'Confirmación explícita del usuario.' }
      },
      required: ['folderPath'],
      additionalProperties: false
    }
  },
  {
    name: 'list_workspaces',
    description: 'Lista todos los workspaces compartidos a los que el usuario tiene acceso. Útil para ver dónde más puede operar.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Máximo a devolver (1-100, default 25).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_document_content_at_revision',
    description: 'DEPRECATED: no hay historial de revisiones en Firestore — esta tool sólo devuelve la sugerencia de usar git_log + git_show. Para historial real usa `git_log` + `read_worker_file` sobre el archivo en /workspace. Se removerá en v2 del agente.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        revision: { type: 'string', description: 'Hash o índice de revisión.' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'upload_external_url',
    description: 'Descarga una URL pública e ingiere el contenido como documento markdown nuevo. Bloquea hosts privados/localhost. Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        targetFolder: { type: 'string' },
        name: { type: 'string', description: 'Nombre del documento. Si se omite usa el último segmento del path de la URL.' },
        confirmed: { type: 'boolean' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'download_workspace_bundle',
    description: 'DEPRECATED para zip: sólo devuelve manifiesto (lista de docs + metadata). Para zip binario real el usuario debe usar el botón "Exportar" del workspace. Si necesitas el listado completo en una llamada, prefiere `inspect_workspace` (estructura) o `read_workspace_bundle` (con contenidos). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: 'Si se especifica, solo incluye docs bajo ese path.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'invite_member',
    description: 'Añade un userId/email a la lista de invitaciones pendientes del workspace. Solo el owner puede invitar. Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        userIdOrEmail: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      required: ['userIdOrEmail'],
      additionalProperties: false
    }
  },
  {
    name: 'remove_member',
    description: 'Quita un miembro del workspace (no puede ser el owner). Solo el owner puede ejecutar. Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      required: ['userId'],
      additionalProperties: false
    }
  },
  {
    name: 'change_workspace_settings',
    description: 'Modifica name, description o visibility del workspace activo. Solo owner.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'shared'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'transfer_workspace_ownership',
    description: 'Transfiere ownership a otro miembro existente. Pierdes permisos administrativos. Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        newOwnerId: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      required: ['newOwnerId'],
      additionalProperties: false
    }
  },
  {
    name: 'list_members',
    description: 'Lista miembros del workspace activo y sus roles, además de invitaciones pendientes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'git_diff',
    description: 'Ejecuta git diff en el worker. Soporta path específico y staged:true para ver index. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        staged: { type: 'boolean', description: 'Si true, muestra git diff --cached.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'git_pull',
    description: 'git pull del worker desde el remote. Read-write (modifica filesystem del worker).',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Default: origin' },
        branch: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'git_push_branch',
    description: 'git push del worker hacia el remote. Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string' },
        branch: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'git_create_branch',
    description: 'Crea una nueva rama y la activa (`git checkout -b <branch>`) dentro del worker. Úsala antes de hacer cambios que quieras aislar de main. Si la rama ya existe, fallará — entonces usa `git_checkout` directamente.',
    parameters: {
      type: 'object',
      properties: { branch: { type: 'string' } },
      required: ['branch'],
      additionalProperties: false
    }
  },
  {
    name: 'git_checkout',
    description: 'Ejecuta `git checkout <target>` dentro del worker (branch existente o commit hash). Modifica el working tree del worker. Úsala para cambiar de rama o ir a un commit puntual. Si la rama no existe, prefiere `git_create_branch`. Cambios sin commit pueden bloquear el checkout — usa `git_status` antes.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
      additionalProperties: false
    }
  },
  {
    name: 'git_revert_commit',
    description: 'Revierte un commit (crea un nuevo commit que deshace los cambios). Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        sha: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      required: ['sha'],
      additionalProperties: false
    }
  },
  {
    name: 'read_worker_file',
    description: 'Lee un archivo dentro de /workspace del worker (head -c N). Read-only. Usa para inspeccionar archivos específicos.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relativo a /workspace.' },
        maxBytes: { type: 'number', description: '256..200000 bytes, default 50000.' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'write_worker_file',
    description: 'Escribe contenido a un archivo dentro de /workspace del worker (sobrescribe). Crea directorios padre. Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        confirmed: { type: 'boolean' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'tail_worker_logs',
    description: 'Devuelve las últimas N líneas de un archivo (tail) dentro del worker. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        lines: { type: 'number', description: '1..500, default 100.' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'kill_worker_process',
    description: 'Envía una señal (TERM, KILL, HUP, INT, QUIT) a un proceso por PID dentro del worker. Requiere confirmed:true. Úsala para terminar procesos colgados que detectaste con `run_worker_command "ps aux"`. Default signal=TERM (gracioso); usa KILL solo si TERM no respondió en ~5s.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'string' },
        signal: { type: 'string', enum: ['TERM', 'KILL', 'HUP', 'INT', 'QUIT'] },
        confirmed: { type: 'boolean' }
      },
      required: ['pid'],
      additionalProperties: false
    }
  },
  {
    name: 'restart_worker',
    description: 'DEPRECATED: el agente desde Cloud Run no controla Docker en humanizar2. Esta tool sólo devuelve la sugerencia (`pkill -f /app/index.js`) — el daemon `agora-host-sync` revive containers caídos automáticamente. Para forzar restart usa `run_worker_command` con `pkill -f /app/index.js`. Se removerá en v2.',
    parameters: { type: 'object', properties: { confirmed: { type: 'boolean' } }, additionalProperties: false }
  },
  {
    name: 'start_worker',
    description: 'DEPRECATED: requiere sudo en humanizar2 (`edu-worker-manager add <wsId>`), no expuesto desde Cloud Run. Esta tool sólo devuelve la sugerencia. Si el workspace no tiene worker, indica al usuario que lo solicite a admin. Se removerá en v2.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'prove_step',
    description: 'Pide al runtime ST que pruebe una conclusión a partir de axiomas declarados en el program. Devuelve status (provable/unknown/unprovable).',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'Programa ST con `logic` y `axiom` declarados.' },
        conclusion: { type: 'string', description: 'Fórmula a derivar.' },
        fromAxioms: { type: 'array', items: { type: 'string' }, description: 'Nombres de axiomas a usar.' }
      },
      required: ['program', 'conclusion'],
      additionalProperties: false
    }
  },
  {
    name: 'compare_logic_profiles',
    description: 'Evalúa la validez de una fórmula en múltiples perfiles ST a la vez para comparar. Útil para mostrar qué lógicas la consideran válida.',
    parameters: {
      type: 'object',
      properties: {
        formula: { type: 'string' },
        profiles: { type: 'array', items: { type: 'string' }, description: 'IDs de perfiles. Si vacío usa los primeros 6.' }
      },
      required: ['formula'],
      additionalProperties: false
    }
  },
  {
    name: 'formalize_document_section',
    description: 'Formaliza la sección de un documento (delimitada por un heading) usando autologic. Si no se da headingTitle formaliza el doc completo.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        headingTitle: { type: 'string' },
        profile: { type: 'string', description: 'Perfil ST destino (default classical.propositional).' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'st_check',
    description: 'Verifica si una fórmula ST es válida y satisfacible bajo un perfil lógico. Devuelve { valid, errors, result }. result puede ser sat/unsat/unknown (perfiles clásicos) o T/F/both/neither (Belnap).',
    parameters: {
      type: 'object',
      properties: {
        formula: { type: 'string', description: 'Fórmula ST en notación nativa o Unicode (¬, ∧, ∨, →, ↔). Ej: "P → P" o "P & ~P".' },
        profile: { type: 'string', description: 'Perfil lógico (classical.propositional, modal.k, paraconsistent.belnap, etc.). Default classical.propositional.' }
      },
      required: ['formula'],
      additionalProperties: false
    }
  },
  {
    name: 'st_derive',
    description: 'Intenta derivar `goal` desde una lista de `premises` bajo un perfil lógico. Devuelve { valid, steps, countermodel? } — los pasos son la prueba serializada y countermodel viene solo cuando la derivación falla.',
    parameters: {
      type: 'object',
      properties: {
        premises: { type: 'array', items: { type: 'string' }, description: 'Lista de premisas como strings ST (cada una se registra como axiom).' },
        goal: { type: 'string', description: 'Fórmula objetivo a derivar.' },
        profile: { type: 'string', description: 'Perfil lógico. Default classical.propositional.' }
      },
      required: ['premises', 'goal'],
      additionalProperties: false
    }
  },
  {
    name: 'st_countermodel',
    description: 'Busca un contramodelo de una fórmula bajo un perfil. Si la fórmula es válida devuelve { valid: true }; si no, devuelve { valid: false, assignments } con un asignamiento concreto que la falsifica.',
    parameters: {
      type: 'object',
      properties: {
        formula: { type: 'string', description: 'Fórmula ST a contramodelar.' },
        profile: { type: 'string', description: 'Perfil lógico. Default classical.propositional.' }
      },
      required: ['formula'],
      additionalProperties: false
    }
  },
  {
    name: 'st_formalize',
    description: 'Heurística básica para convertir prosa libre (es) a una fórmula ST. Detecta conectivos simples: "si X entonces Y" → X → Y, "no X" → ¬X, "X y Y" → X ∧ Y, "X o Y" → X ∨ Y, "X si y sólo si Y" → X ↔ Y. Si la confianza < 0.5 devuelve suggestion=null. Para textos largos usa formalize_text.',
    parameters: {
      type: 'object',
      properties: {
        proseText: { type: 'string', description: 'Texto en español a formalizar.' },
        hint: { type: 'string', description: 'Perfil ST sugerido (default classical.propositional).' }
      },
      required: ['proseText'],
      additionalProperties: false
    }
  },
  {
    name: 'bulk_create_board_cards',
    description: 'Crea múltiples tarjetas Kanban en una sola llamada (máximo 50). Cada item del array debe tener al menos columnId y title.',
    parameters: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              columnId: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' }
            },
            required: ['columnId', 'title']
          }
        }
      },
      required: ['cards'],
      additionalProperties: false
    }
  },
  {
    name: 'outline_document',
    description: 'Devuelve el esquema (headings markdown) de un documento.',
    parameters: {
      type: 'object',
      properties: { documentId: { type: 'string' } },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'find_broken_links',
    description: 'Encuentra enlaces markdown que apuntan a docs inexistentes en el workspace. Ignora URLs externas y anchors. Procesa una página de target-docs por llamada; itera page.nextCursor para escanear todo el workspace.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        pageSize: { type: 'number', description: 'Tamaño de la página de scan Firestore. Default 2000, máx 10000.' },
        cursor: { type: 'string', description: 'Cursor opaco para continuar paginación de docs target.' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'find_duplicates',
    description: 'Detecta documentos duplicados (mismo hash) y similares (Jaccard de shingles). Procesa UNA página por llamada con confirm:true. Si page.hasMore=true, llama de nuevo con el cursor para procesar más páginas.',
    parameters: {
      type: 'object',
      properties: {
        minSimilarity: { type: 'number', description: '0.1-1, default 0.6.' },
        confirm: { type: 'boolean', description: 'Requerido en la primera llamada para confirmar el escaneo.' },
        pageSize: { type: 'number', description: 'Tamaño de la página de scan Firestore. Default 2000, máx 10000.' },
        cursor: { type: 'string', description: 'Cursor opaco para procesar la siguiente página.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'apply_snippet_to_document',
    description: 'Inserta un snippet al inicio o al final del contenido de un documento. Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        snippetId: { type: 'string' },
        position: { type: 'string', enum: ['start', 'end', 'cursor'] },
        confirmed: { type: 'boolean' }
      },
      required: ['documentId', 'snippetId'],
      additionalProperties: false
    }
  },
  {
    name: 'focus_document_section',
    description: 'Pide a la UI scrollear/seleccionar una sección específica del documento abierto (por heading o por número de línea).',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        headingTitle: { type: 'string' },
        line: { type: 'number' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'prompt_user_choice',
    description: 'Presenta una pregunta con N opciones (2-8) al usuario y espera su respuesta antes de continuar.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        choices: { type: 'array', items: { type: 'string' } }
      },
      required: ['question', 'choices'],
      additionalProperties: false
    }
  },
  {
    name: 'show_diff_to_user',
    description: 'Muestra al usuario un diff before→after y le pide confirmar antes de aplicar el cambio. Útil antes de modificaciones masivas.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        before: { type: 'string' },
        after: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'report_status_to_user',
    description: 'Envía un status persistente al usuario ("Estoy haciendo X de Y, voy en Z%"). Útil en operaciones largas.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        detail: { type: 'string' }
      },
      required: ['status'],
      additionalProperties: false
    }
  },
  {
    name: 'list_recent_actions',
    description: 'Devuelve las últimas N tools ejecutadas por el agente para este user/workspace, leídas del audit log.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        sinceMs: { type: 'number', description: 'Timestamp ms desde el cual filtrar.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_agent_audit_log',
    description: 'Audit log persistido del agente. Filtrable por tool name.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        tool: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_subscription_status',
    description: 'Devuelve el plan vigente del usuario (free, pro, etc.), fecha de expiración y método de pago si existe. Úsala cuando el user pregunte: "¿qué plan tengo?", "¿me caducó la suscripción?", "¿puedo usar X feature pago?". NO uses para invitar miembros u otras acciones de workspace.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_quota',
    description: 'Cuotas globales del usuario: documentCount (total entre workspaces), workspacesAccessible, storageBytesUsed. Úsala para preguntas tipo "¿cuántos docs tengo en total?", "¿cuánto espacio uso?", "¿en cuántos workspaces participo?". Para el detalle de un workspace concreto usa `get_workspace_quota_detail`.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_workspace_quota_detail',
    description: 'Detalle del workspace activo: nombre, tipo (personal/shared), plan asociado, cuota local. Úsala antes de operaciones que dependen del plan (e.g. invitar miembros sólo en shared). Para datos cross-workspace usa `list_quota`.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'duplicate_document',
    description: 'Clona un documento con su contenido completo (hidrata desde MinIO). Si no se da `newName`, usa "<original> (copia)". Acepta `targetFolder` para clonar en otro path. Úsala para crear plantillas a partir de existentes, hacer backups locales antes de cambios masivos, o "duplica este doc en otra carpeta".',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        newName: { type: 'string' },
        targetFolder: { type: 'string' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'get_storage_usage',
    description: 'Resumen real de uso de espacio del workspace: documentCount, totalBytes, minioBytes (storage), firestoreBytes (índice). Úsala para "¿cuánto espacio uso?", "¿estoy cerca del límite?", para diagnosticar workspaces hinchados. Para encontrar los docs grandes específicos usa `find_large_documents`.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'find_large_documents',
    description: 'Lista documentos cuyo size supera minBytes (default 100KB), ordenados desc. Procesa una página por llamada; itera page.nextCursor para escanear más.',
    parameters: {
      type: 'object',
      properties: {
        minBytes: { type: 'number' },
        limit: { type: 'number', description: '1..50, default 20' },
        pageSize: { type: 'number', description: 'Tamaño de la página de scan Firestore. Default 2000, máx 10000.' },
        cursor: { type: 'string', description: 'Cursor opaco para continuar paginación.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_recent_workspace_activity',
    description: 'Lista los documentos editados en las últimas `sinceHours` horas (default 24, máx 720=30 días), orden updatedAt desc. Úsala para "¿qué he tocado hoy?", "qué cambió esta semana", o como punto de entrada para retomar trabajo reciente.',
    parameters: {
      type: 'object',
      properties: {
        sinceHours: { type: 'number', description: '1..720, default 24' },
        limit: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_favorites',
    description: 'Lista los documentos que el usuario marcó como favoritos en este workspace. Úsala para "muéstrame mis favoritos", "abre mis docs marcados", o cuando vayas a ofrecer atajos. NO uses para listar todos los docs (eso es `list_documents`).',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'add_favorite',
    description: 'Marca un documento como favorito del usuario. Úsala cuando el user diga "marca esto", "agrega a favoritos", "ponle estrella". Ejemplo: add_favorite({ documentId: "Notas de clase 3" }).',
    parameters: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'], additionalProperties: false }
  },
  {
    name: 'remove_favorite',
    description: 'Desmarca un documento como favorito. Úsala para "quita esto de favoritos", "saca la estrella".',
    parameters: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'], additionalProperties: false }
  },
  {
    name: 'lint_document',
    description: 'Linter ligero (~7 reglas regex) para markdown del documento. Para las 53 reglas completas usa el panel Problemas (open_app_panel problems).',
    parameters: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'], additionalProperties: false }
  },
  {
    name: 'lint_st_document',
    description: 'Ejecuta el runtime ST sobre el documento .st y devuelve los diagnostics (errores, warnings, contramodelos). Read-only.',
    parameters: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'], additionalProperties: false }
  },
  {
    name: 'list_active_terminal_sessions',
    description: 'Lista las sesiones de terminal/PTY activas del worker del workspace (devuelve sessionId, abierto desde, last-active). Útil para diagnosticar "tengo una terminal colgada" o cuando vas a ejecutar comandos largos y quieres saber si ya hay PTY abiertas.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'kill_terminal_session',
    description: 'DEPRECATED: no hay endpoint REST de Cloud Run hacia el hub para cerrar PTY. Esta tool sólo devuelve sugerencia. Para terminar procesos del workspace usa `kill_worker_process` (mata por PID dentro del worker). Se removerá en v2.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['sessionId'], additionalProperties: false }
  },
  {
    name: 'archive_board_card',
    description: 'Archiva (oculta) o desarchiva (archived:false) una tarjeta Kanban sin borrarla. Más suave que `delete_board_card` — la tarjeta sigue en BD pero no aparece en el tablero. Úsala para tareas "hechas hace tiempo que no quieres ver" o para limpiar visualmente sin perder historia.',
    parameters: { type: 'object', properties: { cardId: { type: 'string' }, archived: { type: 'boolean' } }, required: ['cardId'], additionalProperties: false }
  },
  {
    name: 'get_repo_info',
    description: 'Info del repo Forgejo asociado al workspace: org "agora", nombre, URL de clone HTTPS, default branch. Útil para responder "¿cuál es la URL del repo?", "¿cómo clono este workspace?", o antes de operaciones git que requieren el repo provisionado.',
    parameters: { type: 'object', properties: { workspaceId: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'list_workspace_repos',
    description: 'Lista todos los repos Forgejo accesibles para el user en la org "agora" (un repo por workspace al que tiene acceso). Útil para "¿qué repos tengo?", para auditar el catálogo Forgejo.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'provision_workspace_git',
    description: 'Idempotente: asegura que el repo Forgejo del workspace exista y el user tenga acceso (crea repo + agrega colaborador). Útil cuando `get_repo_info` falla con "repo no existe", o tras restaurar Forgejo. Seguro de llamar siempre — si ya está, no hace nada.',
    parameters: { type: 'object', properties: { workspaceId: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'extract_text_from_pdf',
    description: 'Extrae el texto plano de un PDF subido al workspace (lee binario de MinIO via storagePath y corre extractor). Read-only. Úsala cuando el user adjunte un PDF y quiera "resumir/analizar/buscar" su contenido — antes de pasar el texto a `summarize_document` o citar pasajes. Si el doc no tiene storagePath, fue subido como texto plano: usa `read_document` directamente.',
    parameters: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'], additionalProperties: false }
  },
  {
    name: 'inspect_sync_outbox',
    description: 'Lista los eventos de sincronización pendientes del workspace que aún no se enviaron a clientes via RTDB. Úsala cuando el user reporte "el cambio no aparece", "el archivo no se sincronizó" o para diagnosticar desfase Firestore↔front. Si el outbox crece, el drainer cron `/api/cron/drain-outbox` está atrasado.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false }
  },
  {
    name: 'force_emit_sync_ping',
    description: 'Emite manualmente un ping RTDB (`sync-events/<workspaceId>`) para forzar refresh en clientes conectados. `op` = created|updated|deleted|refresh. Úsala cuando un cliente quedó desincronizado y necesita reconciliar sin recargar página. NO uses por defecto: el sistema ya emite pings en cada write.',
    parameters: { type: 'object', properties: { op: { type: 'string' }, path: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'get_document_sync_state',
    description: 'Diagnostica el estado de sync de un documento: `synced` (Firestore+MinIO ok), `storage-only` (sólo en MinIO, falta Firestore), `firestore-only` (sólo metadata, sin contenido en MinIO), `empty`. Úsala cuando el user reporte "este doc no aparece bien", "veo el nombre pero está vacío", para auditar drift Firestore↔MinIO.',
    parameters: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'], additionalProperties: false }
  },
  {
    name: 'accept_invite',
    description: 'Acepta una invitación pendiente al workspace especificado. El user pasa a ser miembro con el rol que definió quien invitó. Úsala cuando el user diga "acepta la invitación de X", "entrar al workspace Y". El user debe haber sido añadido previamente a pendingInvites por el owner.',
    parameters: { type: 'object', properties: { workspaceId: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'decline_invite',
    description: 'Rechaza una invitación pendiente al workspace (el user no entra y se elimina de pendingInvites). Úsala para "rechaza la invitación", "no quiero entrar a ese workspace".',
    parameters: { type: 'object', properties: { workspaceId: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'find_orphaned_concepts',
    description: 'Lista conceptos del glosario semántico que no tienen relaciones (candidatos a cleanup, fusión con `merge_concepts`, o documentación adicional). Úsala para auditorías de salud semántica o cuando el user pida "limpia el glosario".',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'merge_concepts',
    description: 'Fusiona dos conceptos: las relaciones de fromId se reasignan a intoId y fromId se elimina. Requiere confirmed:true.',
    parameters: { type: 'object', properties: { fromId: { type: 'string' }, intoId: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['fromId', 'intoId'], additionalProperties: false }
  },
  {
    name: 'start_subscription_checkout',
    description: 'Sugiere al frontend abrir el panel de pricing/checkout para el plan indicado (free|pro|...). El checkout real corre en navegador con MercadoPago Bricks; esta tool sólo emite la señal UI. Úsala cuando el user pida "quiero suscribirme", "upgrade a pro", "pagar el plan".',
    parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'], additionalProperties: false }
  },
  {
    name: 'import_snippets_from_url',
    description: 'Importa hasta 50 snippets desde una URL pública que devuelva JSON [{title, markdown, category?, description?}]. Requiere confirmed:true.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['url'], additionalProperties: false }
  },
  {
    name: 'find_unused_snippets',
    description: 'Detecta snippets cuyo título no aparece referenciado en ningún documento del workspace (heurística texto, no semántica). Útil para limpieza: el user dice "qué snippets no estoy usando" — sugerir borrar o reorganizar. Puede tener falsos positivos si referencian por contenido.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_dictionary_words',
    description: 'Lista las palabras del diccionario personal del linter — son palabras que el spell-check ya NO marca como error. Úsala antes de añadir/quitar para evitar duplicados, o cuando el user pregunte "¿qué palabras ignora el linter?".',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'add_word_to_dictionary',
    description: 'Añade una palabra al diccionario personal del linter para que deje de marcarla como error de ortografía. Úsala cuando el user diga "no es un error", "agrega [palabra] al diccionario", "ignora esta palabra". Útil para tecnicismos del dominio (e.g. "modus", "tableau", "Quine").',
    parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false }
  },
  {
    name: 'remove_word_from_dictionary',
    description: 'Quita una palabra del diccionario personal del linter (volverá a marcarla como error). Úsala cuando se agregó por error.',
    parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false }
  },
  {
    name: 'agent_plan_set',
    description: 'Crea/reemplaza un plan visible al usuario para una tarea multi-paso (≤30 pasos). DEBE llamarse al inicio de tareas que requieren ≥3 tools o cambios destructivos. El usuario ve el checklist en la UI.',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' }, description: 'Descripciones cortas de cada paso (≤280 chars).' }
      },
      required: ['steps'],
      additionalProperties: false
    }
  },
  {
    name: 'agent_plan_update_step',
    description: 'Actualiza el estado de un paso del plan: pending|in_progress|completed|skipped|failed. Marca in_progress al empezarlo y completed/failed al terminarlo.',
    parameters: {
      type: 'object',
      properties: {
        stepIndex: { type: 'number' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'skipped', 'failed'] },
        notes: { type: 'string', description: 'Nota opcional con detalles del paso.' }
      },
      required: ['stepIndex', 'status'],
      additionalProperties: false
    }
  },
  {
    name: 'agent_plan_get',
    description: 'Devuelve el plan activo de la conversación (steps + status de cada uno). Úsala al inicio de un turno cuando ya hay plan en curso, antes de decidir qué paso atacar a continuación. Si no hay plan, devuelve null y debes considerar crear uno con `agent_plan_set`.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'agent_plan_clear',
    description: 'Descarta el plan activo. Úsala cuando la tarea concluyó (todos los steps en done) o cuando el user cambió completamente de rumbo y el plan ya no aplica. Si solo cambian algunos pasos, prefiere `agent_plan_set` (reemplaza).',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'agent_remember',
    description: 'Guarda un hecho persistente sobre el user (scope=user) o sobre este workspace (scope=workspace, default). Útil para preferencias, dominio del user, decisiones de diseño. value puede ser cualquier JSON.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '1..80 chars, ej. "user.field_of_study"' },
        value: { description: 'Cualquier valor JSON serializable.' },
        scope: { type: 'string', enum: ['user', 'workspace'] }
      },
      required: ['key', 'value'],
      additionalProperties: false
    }
  },
  {
    name: 'agent_recall_memory',
    description: 'Recupera una memoria persistente del user (scope=user) o del workspace (scope=workspace). Si pasas `key` devuelve esa entrada; si lo omites devuelve TODAS las del scope. Úsala al INICIO de tareas relevantes para chequear preferencias previas, dominio del user, decisiones de diseño guardadas. Ejemplo: `agent_recall_memory({ scope: "user" })` antes de proponer un perfil lógico.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        scope: { type: 'string', enum: ['user', 'workspace'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'agent_list_memories',
    description: 'Lista los KEYS de memorias persistentes guardadas — un inventario barato para saber qué hay. Si necesitas el valor, llama después `agent_recall_memory({ key })`. Úsala cuando vayas a guardar algo nuevo para chequear si ya existe key relacionado.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'agent_forget',
    description: 'Elimina una memoria persistente específica por key+scope. Úsala cuando el user diga "olvida X", "ya no apliques esa preferencia", o cuando detectes que la memoria es obsoleta.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        scope: { type: 'string', enum: ['user', 'workspace'] }
      },
      required: ['key'],
      additionalProperties: false
    }
  },
  {
    name: 'register_subtask',
    description: 'Registra una subtarea con prompt explícito y scope acotado. IMPORTANTE: NO ejecuta en paralelo — la subtarea se procesa SECUENCIALMENTE dentro del mismo turno del agente. No spawnea un proceso aparte, no abre otro stream, no hay concurrencia real. Úsala para: (a) descomponer tareas complejas en pasos auditables ("audita duplicados", "limpia conceptos huérfanos"); (b) dejar registro del scope/permisos esperados de cada paso. NO la uses esperando que el sub-prompt corra en background — para eso no existe tool hoy.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Prompt explícito de la subtarea (≤500 chars).' },
        scope: { type: 'string', enum: ['read-only', 'workspace', 'full'], description: 'Permisos esperados de la subtarea: read-only sólo lee; workspace puede editar docs/snippets/board; full incluye worker y git. Es metadato — la ejecución sigue inline en el turno actual.' },
        maxIterations: { type: 'number', description: 'Budget sugerido de iteraciones (1..15, default 5). Metadato informativo: no hay loop aislado.' }
      },
      required: ['task'],
      additionalProperties: false
    }
  },
  {
    name: 'spawn_subagent',
    description: 'DEPRECATED — alias de `register_subtask`. El nombre era engañoso: no spawnea ejecución paralela, registra una subtarea que se procesa inline en el mismo turno. Usa `register_subtask` directamente. Este alias se mantiene por compatibilidad y será removido en una versión futura.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Prompt explícito de la subtarea (≤500 chars).' },
        scope: { type: 'string', enum: ['read-only', 'workspace', 'full'], description: 'Permisos esperados (metadato).' },
        maxIterations: { type: 'number', description: 'Budget sugerido de iteraciones (1..15, default 5).' }
      },
      required: ['task'],
      additionalProperties: false
    }
  },
  {
    name: 'agent_set_hooks',
    description: 'Configura hooks PreToolUse/PostToolUse/UserPromptSubmit en Firestore para que el agente los respete. Cada hook = string con instrucciones que el modelo ve antes/después de tool calls. Requiere confirmed:true.',
    parameters: {
      type: 'object',
      properties: {
        preToolUse: { type: 'array', items: { type: 'string' } },
        postToolUse: { type: 'array', items: { type: 'string' } },
        userPromptSubmit: { type: 'array', items: { type: 'string' } },
        confirmed: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'agent_list_hooks',
    description: 'Lista los hooks configurados (PreToolUse, PostToolUse, UserPromptSubmit). Úsala antes de cambios con `agent_set_hooks` para no perder los existentes, o cuando el user pregunte "¿qué hooks tengo activos?".',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'agent_save_turn_snapshot',
    description: 'Guarda un snapshot del turn actual (messages + toolCalls) en Firestore para replay futuro.',
    parameters: {
      type: 'object',
      properties: {
        turnId: { type: 'string' },
        summary: { type: 'string' },
        messages: { type: 'array' },
        toolCalls: { type: 'array' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'agent_list_turn_snapshots',
    description: 'Lista los snapshots de turns guardados previamente con `agent_save_turn_snapshot` (orden desc por fecha). Útil para retomar un trabajo: el user dice "sigue lo de ayer", listas snapshots, eliges el relevante. Devuelve turnId + summary.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false }
  },
  {
    name: 'agent_clear_turn_snapshot',
    description: 'Elimina un snapshot específico por turnId. Úsala cuando el snapshot ya no es relevante o ocupa espacio. Para borrar todos no hay tool — debes iterar y llamar por cada turnId.',
    parameters: { type: 'object', properties: { turnId: { type: 'string' } }, required: ['turnId'], additionalProperties: false }
  },
  {
    name: 'agent_dry_run_info',
    description: 'Devuelve si el contexto actual está en modo dry-run. En dry-run las tools destructivas (delete_*, update_document, write_worker_file) NO aplican; devuelven `{ ok:true, dryRun:true, wouldHaveDone:... }`. Úsala al iniciar tareas destructivas para saber si vas a aplicar o sólo simular — y comunícalo al user para evitar declarar falsos cambios.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'query_citation_graph',
    description: 'Devuelve el subgrafo de documents conectados al focus por citas (wiki-links, markdown links, conceptos compartidos, bibliografía). Úsalo PRIMERO para preguntas sobre un doc específico antes de hacer search_documents exhaustivo: te ahorra tokens en workspaces grandes. Acepta docId exacto, título completo o parcial, slug kebab-case o cualquier texto — la tool resuelve internamente por nombre exacto → slug → fuzzy (substring en nombre o contenido). Si resolvió desde un input ambiguo, la respuesta incluye `resolvedFromAmbiguousInput: true` y `resolutionHints` con el docId real.',
    parameters: {
      type: 'object',
      properties: {
        focusDocIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs de Firestore, títulos, slugs o nombres parciales de los documents desde los que expandir. Se resuelven de forma permisiva: pasá lo que tengas a mano.'
        },
        depth: {
          type: 'number',
          description: 'Profundidad BFS. 1-3, default 1.'
        },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['wiki', 'link', 'concept', 'bib'] },
          description: 'Filtra por tipos de cita.'
        }
      },
      required: ['focusDocIds'],
      additionalProperties: false
    }
  },
  {
    name: 'find_related_via_graph',
    description: 'Búsqueda híbrida: combina search lexical con expansión via citation graph. Útil para "docs relacionados con X tema" — devuelve docs ordenados por (graph_distance + lexical_match).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de búsqueda.' },
        seedDocId: { type: 'string', description: 'Doc opcional usado como punto de partida del grafo.' },
        limit: { type: 'number', description: 'Máximo de resultados, default 15, máx 50.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'expand_context',
    description: 'Dado uno o más docs iniciales, devuelve docs conectados via citas que enriquecen el contexto. Llámalo ANTES de read_workspace_bundle para que el bundle incluya el contexto relacionado por grafo sin escanear el workspace completo.',
    parameters: {
      type: 'object',
      properties: {
        initialDocIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs de documents iniciales.'
        },
        hops: { type: 'number', description: 'Saltos a expandir. 1-2, default 1.' }
      },
      required: ['initialDocIds'],
      additionalProperties: false
    }
  }
];

export const AGORA_AGENT_TOOL_MAP = Object.fromEntries(
  AGORA_AGENT_TOOLS.map(tool => [tool.name, tool])
) as Record<string, AgentToolDefinition>;

export const AGORA_AGENT_TOOL_NAMES = AGORA_AGENT_TOOLS.map(tool => tool.name);

const toolsForPolicy = (policy?: Partial<AgentAccessPolicy>) => (
  policy ? AGORA_AGENT_TOOLS.filter(tool => isAgentToolAllowedByPolicy(tool.name, policy)) : AGORA_AGENT_TOOLS
);

export const toOpenAITools = (policy?: Partial<AgentAccessPolicy>) => toolsForPolicy(policy).map(tool => ({
  type: 'function' as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }
}));

export const toAnthropicTools = (policy?: Partial<AgentAccessPolicy>) => toolsForPolicy(policy).map(tool => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters
}));

/**
 * Gemini does not support `additionalProperties` in function parameter schemas.
 * Strip it recursively to avoid 400 errors from the API.
 */
function stripAdditionalProperties(schema: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { additionalProperties: _ap, ...rest } = schema;
  if (rest.properties && typeof rest.properties === 'object') {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [
        k,
        stripAdditionalProperties(v)
      ])
    );
  }
  return rest;
}

export const toGeminiTools = (policy?: Partial<AgentAccessPolicy>) => {
  const functionDeclarations = toolsForPolicy(policy).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: stripAdditionalProperties(tool.parameters as unknown as Record<string, unknown>)
  }));
  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
};

/**
 * Core tools subset for smaller models (e.g. Ollama / qwen3:14b).
 * 42 tools overwhelms the context window; we expose ~18 essential ones.
 * The server-side executor still supports ALL tools, so if a smarter model
 * is configured the full set can be sent.
 */
const OLLAMA_CORE_TOOL_NAMES = new Set([
  // Documents — most common operations
  'list_documents',
  'inspect_workspace',
  'search_workspace',
  'read_workspace_bundle',
  'read_document',
  'create_document',
  'update_document',
  'search_documents',
  'list_folders',
  'get_worker_status',
  'run_worker_command',
  // Kanban
  'get_board',
  'create_board_card',
  'move_board_card',
  // Snippets
  'list_snippets',
  'create_snippet',
  'search_snippets',
  // Logic / ST
  'check_logic',
  'formalize_text',
  // Semantic
  'list_concepts',
  'define_concept',
  // Doc intelligence
  'summarize_document',
  'get_workspace_info',
  // External / docs
  'fetch_url',
  'read_agora_doc'
]);

// Ollama uses OpenAI-compatible format but with a reduced tool set
export const toOllamaTools = (policy?: Partial<AgentAccessPolicy>) =>
  toolsForPolicy(policy)
    .filter(tool => OLLAMA_CORE_TOOL_NAMES.has(tool.name))
    .map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
