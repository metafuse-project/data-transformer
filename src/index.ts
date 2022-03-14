type TransformationMapping =
  | TransformationMappingFragment
  | TransformationMappingFragment[]
  | { [name: string]: TransformationMappingFragment }
  | TransformationMapping[]
  | { [name: string]: TransformationMapping }

type TransformationDatatype = string

type TransformationNestedMappings = { [name: string]: TransformationMapping }

export type TransformationDocumentMapping = string | string[] | { [name: string]: TransformationDocumentMapping } | TransformationDocumentMapping[]

export type TransformationDocumentNestedMappings = { [name: string]: TransformationDocumentMapping }

export type TransformationDocument = {
  properties: TransformationDocumentMapping
  nested?: TransformationDocumentNestedMappings
}

export type DatatypeConverter = (data: any) => any

interface TransformationFragmentInterface {
  readonly path: string[]
  readonly datatype: TransformationDatatype
  readonly isArray: boolean
}

export interface TransformationInterface {
  readonly properties: TransformationMapping
  readonly nested: TransformationNestedMappings
  transform(data: any): any
}

class Transformation implements TransformationInterface {
  constructor(
    readonly properties: TransformationMapping,
    readonly nested: TransformationNestedMappings,
    private readonly transformer: DataTransformer,
  ) {}

  transform(data: any): any {
    return this.transformer.transform(data, this)
  }
}

export class MalformedConfigurationError extends Error {}

class TransformationMappingFragment implements TransformationFragmentInterface {
  constructor(readonly path: string[], readonly datatype: TransformationDatatype, readonly isArray: boolean) {}
}

export class DataTransformer {
  private readonly datatypeConverters: Map<string, DatatypeConverter>

  constructor(datatypeConverters?: { [name: string]: DatatypeConverter }) {
    this.datatypeConverters = new Map<string, DatatypeConverter>()
    typeof datatypeConverters === 'object' && this.registerDatatypeConverterMultiple(datatypeConverters)
  }

  registerDatatypeConverter(name: string, converter: DatatypeConverter): this {
    this.datatypeConverters.set(name, converter)
    return this
  }

  registerDatatypeConverterMultiple(datatypeConverters: { [name: string]: DatatypeConverter }): this {
    Object.entries(datatypeConverters).forEach(([name, converter]) => this.registerDatatypeConverter(name, converter))
    return this
  }

  createTransformation(document: TransformationDocument & any): TransformationInterface {
    if (!document.properties) {
      throw new MalformedConfigurationError('Configuration properties are missing')
    }
    let nested
    let nestedNames: string[]
    if (document.nested) {
      nestedNames = Object.keys(document.nested)
      nested = this.resolveTransformationNestedMappings(document.nested, nestedNames)
    } else {
      nestedNames = []
      nested = {}
    }
    const mapping = this.resolveTransformationMapping(document.properties, nestedNames)
    return new Transformation(mapping, nested, this)
  }

  transform(data: any, transformation: TransformationInterface) {
    return this.handleTransform(
      new Proxy(data, {
        get(target, name, receiver) {
          return name === '$root' ? data : Reflect.get(target, name, receiver)
        },
      }),
      transformation.properties,
      transformation.nested,
    )
  }

  private handleTransform(data: any, mapping: TransformationMapping, nestedMappings: TransformationNestedMappings): any {
    if (mapping instanceof TransformationMappingFragment) {
      const value = DataTransformer.getObjectValueByPath(data, mapping.path)
      if (value === undefined || value === null) {
        return mapping.isArray ? [] : null
      }
      return this.handleTransformFragment(value, data, mapping.datatype, nestedMappings, mapping.isArray)
    }
    if (Array.isArray(mapping)) {
      return mapping.map(value => this.handleTransform(data, value, nestedMappings))
    } else {
      return Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, this.handleTransform(data, value, nestedMappings)]))
    }
  }

  private handleTransformFragment(
    value: any,
    parent: any,
    datatype: TransformationDatatype,
    nestedMappings: TransformationNestedMappings,
    isArray: boolean,
  ): any {
    if (isArray) {
      return Array.isArray(value) ? value.map(item => this.handleTransformFragment(item, parent, datatype, nestedMappings, false)) : []
    }
    if (datatype.startsWith('$')) {
      return this.handleTransform(
        new Proxy(value, {
          get(target, name, receiver) {
            if (name === '$parent') {
              return parent
            } else if (name === '$root') {
              return parent.$root
            }
            return Reflect.get(target, name, receiver)
          },
        }),
        nestedMappings[datatype],
        nestedMappings,
      )
    } else {
      return this.datatypeConverters.get(datatype)?.(value)
    }
  }

  private resolveTransformationNestedMappings(data: TransformationDocumentNestedMappings, nestedNames: string[]): TransformationNestedMappings {
    if (!data) {
      return {}
    }
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Nested mappings must be an object')
    }
    return this.resolveTransformationMapping(data, nestedNames) as TransformationNestedMappings
  }

  private resolveTransformationMapping(data: TransformationDocumentMapping, nestedNames: string[]): TransformationMapping {
    if (typeof data === 'string') {
      return this.resolveTransformationMappingFragment(data, nestedNames)
    } else if (typeof data === 'object') {
      if (Array.isArray(data)) {
        return data.map(value => this.resolveTransformationMapping(value, nestedNames))
      } else {
        return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, this.resolveTransformationMapping(value, nestedNames)]))
      }
    }
    return data
  }

  private resolveTransformationMappingFragment(rule: string, nestedNames: string[]): TransformationMappingFragment {
    const parts = rule.split(':')
    if (parts.length === 2) {
      let datatype
      let isArray
      if (parts[1].endsWith('[]')) {
        datatype = parts[1].replace(/\[]$/, '')
        isArray = true
      } else {
        datatype = parts[1]
        isArray = false
      }
      if (parts[0].length > 0) {
        if (datatype.startsWith('$')) {
          if (nestedNames.indexOf(datatype) === -1) {
            throw new MalformedConfigurationError('Undefined nested mapping: ' + datatype)
          }
        } else {
          if (!this.datatypeConverters.has(datatype)) {
            throw new MalformedConfigurationError('Undefined datatype: ' + datatype)
          }
        }
        return new TransformationMappingFragment(parts[0].split('.'), datatype, isArray)
      }
    }
    throw new MalformedConfigurationError('Malformed mapping rule:' + rule)
  }

  static getObjectValueByPath(object: any, path: string[]): any {
    try {
      return path.reduce((o, i) => o[i], object)
    } catch (_) {
      return undefined
    }
  }
}
