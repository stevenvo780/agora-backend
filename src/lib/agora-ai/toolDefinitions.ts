import { DocumentType } from '@/types/documents';
import type { AgentToolDefinition } from '@/lib/agora-ai/types';
import { AGENT_UI_PANEL_DESCRIPTION, AGENT_UI_PANELS } from '@/lib/agora-ai/uiPanels';

export const AGORA_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: 'list_documents',
    description: 'Lista documentos del workspace actual. Úsala al explorar el espacio de trabajo o antes de leer, mover o editar archivos.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Carpeta concreta a inspeccionar. Opcional.' },
        type: { type: 'string', enum: Object.values(DocumentType), description: 'Filtra por tipo de documento. Opcional.' },
        limit: { type: 'number', description: 'Máximo de resultados, entre 1 y 100.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'read_document',
    description: 'Lee y devuelve el contenido completo de un documento específico.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Nombre o ID del documento a leer.' }
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
    description: 'Busca documentos por nombre, carpeta o contenido dentro del workspace.',
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
    description: 'Construye un inventario amplio del workspace: carpetas, documentos, snippets, tablero, glosario semántico y estado del worker si está disponible. Úsala como primer paso para tareas generales sobre "todo el workspace".',
    parameters: {
      type: 'object',
      properties: {
        includeWorker: { type: 'boolean', description: 'Si true, consulta el Hub para saber si hay worker conectado.' },
        limit: { type: 'number', description: 'Máximo de elementos por sección, entre 5 y 100.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_workspace',
    description: 'Busca en todo el workspace a la vez: documentos, snippets, conceptos semánticos y tarjetas Kanban.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de búsqueda.' },
        limit: { type: 'number', description: 'Máximo de resultados por sección, entre 1 y 25.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'read_workspace_bundle',
    description: 'Lee un paquete de contexto del workspace en una sola llamada. Puede leer documentos concretos, una carpeta, resultados de búsqueda, snippets y glosario semántico con límites de tamaño.',
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
        maxCharsPerDocument: { type: 'number', description: 'Máximo de caracteres por documento, entre 500 y 12000.' }
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
    name: 'list_glossary_entries',
    description: 'Lista entradas del glosario semántico del workspace.',
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
    name: 'search_glossary_entries',
    description: 'Busca entradas del glosario / conceptos por nombre, definición o fórmula.',
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
  }
];

export const AGORA_AGENT_TOOL_MAP = Object.fromEntries(
  AGORA_AGENT_TOOLS.map(tool => [tool.name, tool])
) as Record<string, AgentToolDefinition>;

export const AGORA_AGENT_TOOL_NAMES = AGORA_AGENT_TOOLS.map(tool => tool.name);

export const toOpenAITools = () => AGORA_AGENT_TOOLS.map(tool => ({
  type: 'function' as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }
}));

export const toAnthropicTools = () => AGORA_AGENT_TOOLS.map(tool => ({
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

export const toGeminiTools = () => [{
  functionDeclarations: AGORA_AGENT_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: stripAdditionalProperties(tool.parameters as unknown as Record<string, unknown>)
  }))
}];

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
  'get_workspace_info'
]);

// Ollama uses OpenAI-compatible format but with a reduced tool set
export const toOllamaTools = () =>
  AGORA_AGENT_TOOLS
    .filter(tool => OLLAMA_CORE_TOOL_NAMES.has(tool.name))
    .map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
