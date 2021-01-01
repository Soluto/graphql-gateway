import * as _ from 'lodash';
import * as opaHelper from '../../opa-helper';
import logger from '../../logger';
import { PolicyType, ResourceMetadata, ResourceRepository } from '../../resource-repository';
import resourceRepository from '../repository';
import { ResourceMetadataInput, PolicyInput } from '../types';

type TempLocalPolicyAttachment = { metadata: ResourceMetadataInput; path: string; type: PolicyType };

const policyMetadataComparer = (p1: PolicyInput, p2: PolicyInput) =>
  p1.metadata.namespace === p2.metadata.namespace && p1.metadata.name === p2.metadata.name;
export default class PolicyAttachmentsHelper {
  protected policyAttachmentsToSave: TempLocalPolicyAttachment[] = [];
  protected policyAttachmentsToDelete: PolicyInput[] = [];

  async sync(oldState: PolicyInput[], newState: PolicyInput[]) {
    const addedOrUpdatedPolicies = _.differenceWith(newState, oldState, _.isEqual);
    await this.generate(addedOrUpdatedPolicies);

    const removedPolicies = _.differenceWith(oldState, newState, policyMetadataComparer);
    this.policyAttachmentsToDelete.push(...removedPolicies);
  }

  private async generate(policies: PolicyInput[]) {
    for (const policy of policies) {
      if (!policyAttachmentStrategies[policy.type]) continue;

      const attachment = await policyAttachmentStrategies[policy.type].generate(policy);
      this.policyAttachmentsToSave.push(attachment);
    }
  }

  async writeToRepo() {
    for (const attachment of this.policyAttachmentsToSave) {
      await policyAttachmentStrategies[attachment.type].saveToRepo(resourceRepository, attachment);
    }

    for (const policy of this.policyAttachmentsToDelete) {
      await policyAttachmentStrategies[policy.type].removeFromRepo(resourceRepository, policy.metadata);
    }
  }

  async cleanup() {
    for (const attachment of this.policyAttachmentsToSave) {
      await policyAttachmentStrategies[attachment.type].cleanup(attachment);
    }
  }
}

const policyAttachmentStrategies = {
  [PolicyType.opa]: {
    generate: async (input: PolicyInput) => {
      const path = await opaHelper.prepareCompiledRegoFile(input.metadata, input.code);
      return { path, metadata: input.metadata, type: PolicyType.opa };
    },
    cleanup: async (attachment: TempLocalPolicyAttachment) => {
      try {
        await opaHelper.deleteLocalRegoFile(attachment.path);
      } catch (err) {
        logger.warn(
          { err, attachment },
          'Failed cleanup of compiled rego file, this did not affect the request outcome'
        );
      }
    },
    saveToRepo: async (resourceRepository: ResourceRepository, attachment: TempLocalPolicyAttachment) => {
      const compiledRego = await opaHelper.readLocalRegoFile(attachment.path);
      const filename = opaHelper.getCompiledFilename(attachment.metadata);
      await resourceRepository.writePolicyAttachment(filename, compiledRego);
    },
    removeFromRepo: async (resourceRepository: ResourceRepository, metadata: ResourceMetadata) => {
      const filename = opaHelper.getCompiledFilename(metadata);
      await resourceRepository.deletePolicyAttachment(filename);
    },
  },
};
