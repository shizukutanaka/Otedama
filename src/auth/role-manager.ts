import { logger } from '../logging/logger';
import { EventBus } from '../event/bus';
import { PoolEvent } from '../event/types';
import { v4 as uuidv4 } from 'uuid';

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Permission {
  id: string;
  name: string;
  description: string;
  resource: string;
  action: string;
  createdAt: string;
  updatedAt: string;
}

export class RoleManager {
  private roles: Map<string, Role>;
  private permissions: Map<string, Permission>;
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.roles = new Map();
    this.permissions = new Map();
    this.eventBus = eventBus;

    // Initialize default roles and permissions
    this.initializeDefaultRoles();
    this.initializeDefaultPermissions();

    // Setup event handlers
    this.setupEventHandlers();
  }

  private initializeDefaultRoles(): void {
    const adminRole: Role = {
      id: uuidv4(),
      name: 'admin',
      description: 'システム管理者',
      permissions: ['*'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const minerRole: Role = {
      id: uuidv4(),
      name: 'miner',
      description: 'マイナー',
      permissions: ['mining:submit_shares', 'mining:get_stats'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.roles.set(adminRole.id, adminRole);
    this.roles.set(minerRole.id, minerRole);
  }

  private initializeDefaultPermissions(): void {
    const permissions: Permission[] = [
      {
        id: uuidv4(),
        name: 'mining:submit_shares',
        description: 'シェアの提出',
        resource: 'mining',
        action: 'submit_shares',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        name: 'mining:get_stats',
        description: '統計情報の取得',
        resource: 'mining',
        action: 'get_stats',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        name: 'admin:manage_roles',
        description: 'ロールの管理',
        resource: 'admin',
        action: 'manage_roles',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: uuidv4(),
        name: 'admin:manage_permissions',
        description: '権限の管理',
        resource: 'admin',
        action: 'manage_permissions',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    permissions.forEach((permission) => {
      this.permissions.set(permission.id, permission);
    });
  }

  private setupEventHandlers(): void {
    this.eventBus.on('roleCreated', (role: Role) => {
      this.roles.set(role.id, role);
      logger.info(`Role created: ${role.name}`);
    });

    this.eventBus.on('roleUpdated', (role: Role) => {
      this.roles.set(role.id, role);
      logger.info(`Role updated: ${role.name}`);
    });

    this.eventBus.on('roleDeleted', (roleId: string) => {
      this.roles.delete(roleId);
      logger.info(`Role deleted: ${roleId}`);
    });

    this.eventBus.on('permissionCreated', (permission: Permission) => {
      this.permissions.set(permission.id, permission);
      logger.info(`Permission created: ${permission.name}`);
    });

    this.eventBus.on('permissionUpdated', (permission: Permission) => {
      this.permissions.set(permission.id, permission);
      logger.info(`Permission updated: ${permission.name}`);
    });

    this.eventBus.on('permissionDeleted', (permissionId: string) => {
      this.permissions.delete(permissionId);
      logger.info(`Permission deleted: ${permissionId}`);
    });
  }

  public async createRole(name: string, description: string, permissions: string[]): Promise<Role> {
    const role: Role = {
      id: uuidv4(),
      name,
      description,
      permissions,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.roles.set(role.id, role);
    this.eventBus.emit('roleCreated', role);
    logger.info(`Created role: ${name}`);

    return role;
  }

  public async updateRole(roleId: string, updates: Partial<Role>): Promise<Role | null> {
    const role = this.roles.get(roleId);
    if (!role) {
      logger.warn(`Role not found: ${roleId}`);
      return null;
    }

    const updatedRole = { ...role, ...updates, updatedAt: new Date().toISOString() };
    this.roles.set(roleId, updatedRole);
    this.eventBus.emit('roleUpdated', updatedRole);
    logger.info(`Updated role: ${roleId}`);

    return updatedRole;
  }

  public async deleteRole(roleId: string): Promise<boolean> {
    if (this.roles.delete(roleId)) {
      this.eventBus.emit('roleDeleted', roleId);
      logger.info(`Deleted role: ${roleId}`);
      return true;
    }
    return false;
  }

  public async createPermission(
    name: string,
    description: string,
    resource: string,
    action: string
  ): Promise<Permission> {
    const permission: Permission = {
      id: uuidv4(),
      name,
      description,
      resource,
      action,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.permissions.set(permission.id, permission);
    this.eventBus.emit('permissionCreated', permission);
    logger.info(`Created permission: ${name}`);

    return permission;
  }

  public async updatePermission(permissionId: string, updates: Partial<Permission>): Promise<Permission | null> {
    const permission = this.permissions.get(permissionId);
    if (!permission) {
      logger.warn(`Permission not found: ${permissionId}`);
      return null;
    }

    const updatedPermission = { ...permission, ...updates, updatedAt: new Date().toISOString() };
    this.permissions.set(permissionId, updatedPermission);
    this.eventBus.emit('permissionUpdated', updatedPermission);
    logger.info(`Updated permission: ${permissionId}`);

    return updatedPermission;
  }

  public async deletePermission(permissionId: string): Promise<boolean> {
    if (this.permissions.delete(permissionId)) {
      this.eventBus.emit('permissionDeleted', permissionId);
      logger.info(`Deleted permission: ${permissionId}`);
      return true;
    }
    return false;
  }

  public getRole(roleId: string): Role | undefined {
    return this.roles.get(roleId);
  }

  public getRoleByName(name: string): Role | undefined {
    return Array.from(this.roles.values()).find((role) => role.name === name);
  }

  public getPermission(permissionId: string): Permission | undefined {
    return this.permissions.get(permissionId);
  }

  public getPermissionByName(name: string): Permission | undefined {
    return Array.from(this.permissions.values()).find((perm) => perm.name === name);
  }

  public getAllRoles(): Role[] {
    return Array.from(this.roles.values());
  }

  public getAllPermissions(): Permission[] {
    return Array.from(this.permissions.values());
  }

  public checkPermission(roleId: string, permission: string): boolean {
    const role = this.roles.get(roleId);
    if (!role) return false;

    // Check if role has the permission
    return role.permissions.includes(permission) || role.permissions.includes('*');
  }
}
