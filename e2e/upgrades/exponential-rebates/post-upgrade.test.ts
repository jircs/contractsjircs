import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import { Contract, ethers } from 'ethers'
import hre from 'hardhat'

import removedABI from './abis/staking'
import allocations, { AllocationState } from './fixtures/allocations'
import indexers from './fixtures/indexers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { advanceEpochs, advanceToNextEpoch, randomHexBytes } from '../../../test/lib/testHelpers'

chai.use(chaiAsPromised)

describe('[AFTER UPGRADE] Exponential rebates upgrade', () => {
  const graph = hre.graph()
  const { Staking, EpochManager } = graph.contracts

  const deployedStaking = new Contract(
    Staking.address,
    new ethers.utils.Interface([...Staking.interface.format(), ...removedABI]),
    graph.provider,
  )

  describe('> Storage variables', () => {
    it(`channelDisputeEpochs should not exist`, async function () {
      await expect(deployedStaking.channelDisputeEpochs()).to.eventually.be.rejected
    })
    it(`rebates should not exist`, async function () {
      await expect(deployedStaking.rebates(123)).to.eventually.be.rejected
    })
  })

  describe('> Allocation state transitions', () => {
    it('Null allocations should remain Null', async function () {
      for (const allocation of allocations.filter((a) => a.state === AllocationState.Null)) {
        await expect(Staking.getAllocationState(allocation.id)).to.eventually.equal(
          AllocationState.Null,
        )
      }
    })

    it('Active allocations should remain Active', async function () {
      for (const allocation of allocations.filter((a) => a.state === AllocationState.Active)) {
        await expect(Staking.getAllocationState(allocation.id)).to.eventually.equal(
          AllocationState.Active,
        )
      }
    })

    it('Closed allocations should remain Closed', async function () {
      for (const allocation of allocations.filter((a) => a.state === AllocationState.Closed)) {
        await expect(Staking.getAllocationState(allocation.id)).to.eventually.equal(
          AllocationState.Closed,
        )
      }
    })

    it('Finalized allocations should transition to Closed', async function () {
      for (const allocation of allocations.filter((a) => a.state === AllocationState.Finalized)) {
        await expect(Staking.getAllocationState(allocation.id)).to.eventually.equal(
          AllocationState.Closed,
        )
      }
    })

    it('Claimed allocations should transition to Closed', async function () {
      for (const allocation of allocations.filter((a) => a.state === AllocationState.Claimed)) {
        await expect(Staking.getAllocationState(allocation.id)).to.eventually.equal(
          AllocationState.Closed,
        )
      }
    })
  })

  describe('> Indexer actions', () => {
    before(async function () {
      // Impersonate indexers
      for (const indexer of indexers) {
        await graph.provider.send('hardhat_impersonateAccount', [indexer.address])
        await graph.provider.send('hardhat_setBalance', [indexer.address, '0x56BC75E2D63100000']) // 100 Eth
        indexer.signer = await SignerWithAddress.create(graph.provider.getSigner(indexer.address))
      }
    })

    it('should be able to collect but not claim rebates', async function () {
      for (const indexer of indexers) {
        for (const allocation of indexer.allocationsBatch2) {
          // Close allocation first
          await advanceToNextEpoch(EpochManager)
          await Staking.connect(indexer.signer).closeAllocation(allocation.id, randomHexBytes())

          // Collect query fees
          const assetHolder = await graph.getDeployer()
          await expect(
            Staking.connect(assetHolder).collect(ethers.utils.parseEther('1000'), allocation.id),
          ).to.eventually.be.fulfilled

          // Claim rebate
          await advanceEpochs(EpochManager, 7)
          const tx = deployedStaking.connect(indexer.signer).claim(allocation.id, false)
          await expect(tx).to.eventually.be.rejected
        }
      }
    })
  })
})
