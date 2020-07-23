import * as envVar from 'env-var';
import { FileSystemStorage } from '../storage';
import { ResourceRepository } from '.';

export class FileSystemResourceRepository extends ResourceRepository {
  protected policyAttachmentsFolderInitialized = false;

  constructor(
    protected storage: FileSystemStorage,
    protected resourceFilePath: string,
    protected policyAttachmentsFolderPath: string
  ) {
    super(storage, resourceFilePath, policyAttachmentsFolderPath);
  }

  async writePolicyAttachment(filename: string, content: Buffer): Promise<void> {
    await this.initializePolicyAttachmentsFolder();
    await super.writePolicyAttachment(filename, content);
  }

  private async initializePolicyAttachmentsFolder() {
    if (this.policyAttachmentsFolderInitialized) return;

    await this.storage.mkdir(this.policyAttachmentsFolderPath, { recursive: true });
    this.policyAttachmentsFolderInitialized = true;
  }

  static fromEnvironment() {
    const resourceFilePath = envVar.get('FS_RESOURCE_REPOSITORY_PATH').required().asString();
    const policyAttachmentsFolderPath = envVar
      .get('FS_REPOSITORY_POLICY_ATTACHMENTS_FOLDER_PATH')
      .required()
      .asString();

    const fsStorage = new FileSystemStorage();
    return new FileSystemResourceRepository(fsStorage, resourceFilePath, policyAttachmentsFolderPath);
  }
}