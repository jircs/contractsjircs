import { expect } from 'chai'
import { constants, BigNumber } from 'ethers'
import { defaultAbiCoder, parseEther } from 'ethers/lib/utils'

import { GraphToken } from '../../build/types/GraphToken'
import { IL1Staking } from '../../build/types/IL1Staking'
import { IController } from '../../build/types/IController'
import { L1GraphTokenGateway } from '../../build/types/L1GraphTokenGateway'
import { L1GraphTokenLockTransferToolMock } from '../../build/types/L1GraphTokenLockTransferToolMock'
import { L1GraphTokenLockTransferToolBadMock } from '../../build/types/L1GraphTokenLockTransferToolBadMock'

import { ArbitrumL1Mocks, L1FixtureContracts, NetworkFixture } from '../lib/fixtures'

import {
  deriveChannelKey,
  getAccounts,
  randomHexBytes,
  toBN,
  toGRT,
  provider,
  Account,
  setAccountBalance,
  impersonateAccount,
} from '../lib/testHelpers'
import { deployContract } from '../lib/deployment'

const { AddressZero } = constants

describe('L1Staking:L2Transfer', () => {
  let me: Account
  let governor: Account
  let indexer: Account
  let slasher: Account
  let l2Indexer: Account
  let delegator: Account
  let l2Delegator: Account
  let mockRouter: Account
  let mockL2GRT: Account
  let mockL2Gateway: Account
  let mockL2GNS: Account
  let mockL2Staking: Account

  let fixture: NetworkFixture
  let fixtureContracts: L1FixtureContracts

  let grt: GraphToken
  let staking: IL1Staking
  let controller: IController
  let l1GraphTokenGateway: L1GraphTokenGateway
  let arbitrumMocks: ArbitrumL1Mocks
  let l1GraphTokenLockTransferTool: L1GraphTokenLockTransferToolMock
  let l1GraphTokenLockTransferToolBad: L1GraphTokenLockTransferToolBadMock

  // Test values
  const indexerTokens = toGRT('10000000')
  const delegatorTokens = toGRT('1000000')
  const tokensToStake = toGRT('200000')
  const subgraphDeploymentID = randomHexBytes()
  const channelKey = deriveChannelKey()
  const allocationID = channelKey.address
  const metadata = randomHexBytes(32)
  const minimumIndexerStake = toGRT('100000')
  const delegationTaxPPM = 10000 // 1%
  // Dummy L2 gas values
  const maxGas = toBN('1000000')
  const gasPriceBid = toBN('1000000000')
  const maxSubmissionCost = toBN('1000000000')

  // Allocate with test values
  const allocate = async (tokens: BigNumber) => {
    return staking
      .connect(indexer.signer)
      .allocateFrom(
        indexer.address,
        subgraphDeploymentID,
        tokens,
        allocationID,
        metadata,
        await channelKey.generateProof(indexer.address),
      )
  }

  before(async function () {
    ;[
      me,
      governor,
      indexer,
      slasher,
      delegator,
      l2Indexer,
      mockRouter,
      mockL2GRT,
      mockL2Gateway,
      mockL2GNS,
      mockL2Staking,
      l2Delegator,
    ] = await getAccounts()

    fixture = new NetworkFixture()
    fixtureContracts = await fixture.load(governor.signer, slasher.signer)
    ;({ grt, staking, l1GraphTokenGateway, controller } = fixtureContracts)
    // Dummy code on the mock router so that it appears as a contract
    await provider().send('hardhat_setCode', [mockRouter.address, '0x1234'])
    arbitrumMocks = await fixture.loadArbitrumL1Mocks(governor.signer)
    await fixture.configureL1Bridge(
      governor.signer,
      arbitrumMocks,
      fixtureContracts,
      mockRouter.address,
      mockL2GRT.address,
      mockL2Gateway.address,
      mockL2GNS.address,
      mockL2Staking.address,
    )

    l1GraphTokenLockTransferTool = (await deployContract(
      'L1GraphTokenLockTransferToolMock',
      governor.signer,
    )) as unknown as L1GraphTokenLockTransferToolMock

    l1GraphTokenLockTransferToolBad = (await deployContract(
      'L1GraphTokenLockTransferToolBadMock',
      governor.signer,
    )) as unknown as L1GraphTokenLockTransferToolBadMock

    await setAccountBalance(l1GraphTokenLockTransferTool.address, parseEther('1'))
    await setAccountBalance(l1GraphTokenLockTransferToolBad.address, parseEther('1'))

    await staking
      .connect(governor.signer)
      .setL1GraphTokenLockTransferTool(l1GraphTokenLockTransferTool.address)

    // Give some funds to the indexer and approve staking contract to use funds on indexer behalf
    await grt.connect(governor.signer).mint(indexer.address, indexerTokens)
    await grt.connect(indexer.signer).approve(staking.address, indexerTokens)

    await grt.connect(governor.signer).mint(delegator.address, delegatorTokens)
    await grt.connect(delegator.signer).approve(staking.address, delegatorTokens)

    await staking.connect(governor.signer).setMinimumIndexerStake(minimumIndexerStake)
    await staking.connect(governor.signer).setDelegationTaxPercentage(delegationTaxPPM) // 1%
  })

  beforeEach(async function () {
    await fixture.setUp()
  })

  afterEach(async function () {
    await fixture.tearDown()
  })

  context('> when not staked', function () {
    describe('transferStakeToL2', function () {
      it('should not allow transferring for someone who has not staked', async function () {
        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            tokensToStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('tokensStaked == 0')
      })
    })
  })

  context('> when staked', function () {
    const shouldTransferIndexerStake = async (
      amountToSend: BigNumber,
      options: {
        expectedSeqNum?: number
        l2Beneficiary?: string
      } = {},
    ) => {
      const l2Beneficiary = options.l2Beneficiary ?? l2Indexer.address
      const expectedSeqNum = options.expectedSeqNum ?? 1
      const tx = staking
        .connect(indexer.signer)
        .transferStakeToL2(l2Beneficiary, amountToSend, maxGas, gasPriceBid, maxSubmissionCost, {
          value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
        })
      const expectedFunctionData = defaultAbiCoder.encode(['tuple(address)'], [[l2Indexer.address]])

      const expectedCallhookData = defaultAbiCoder.encode(
        ['uint8', 'bytes'],
        [toBN(0), expectedFunctionData], // code = 1 means RECEIVE_INDEXER_CODE
      )
      const expectedL2Data = await l1GraphTokenGateway.getOutboundCalldata(
        grt.address,
        staking.address,
        mockL2Staking.address,
        amountToSend,
        expectedCallhookData,
      )

      await expect(tx)
        .emit(l1GraphTokenGateway, 'TxToL2')
        .withArgs(staking.address, mockL2Gateway.address, toBN(expectedSeqNum), expectedL2Data)
    }

    beforeEach(async function () {
      await staking.connect(indexer.signer).stake(tokensToStake)
    })

    describe('receive()', function () {
      it('should not allow receiving funds from a random address', async function () {
        const tx = indexer.signer.sendTransaction({
          to: staking.address,
          value: parseEther('1'),
        })
        await expect(tx).revertedWith('Only transfer tool can send ETH')
      })
      it('should allow receiving funds from the transfer tool', async function () {
        const impersonatedTransferTool = await impersonateAccount(
          l1GraphTokenLockTransferTool.address,
        )
        const tx = impersonatedTransferTool.sendTransaction({
          to: staking.address,
          value: parseEther('1'),
        })
        await expect(tx).to.not.be.reverted
      })
    })
    describe('transferStakeToL2', function () {
      it('should not allow transferring if the protocol is partially paused', async function () {
        await controller.setPartialPaused(true)

        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            tokensToStake.sub(minimumIndexerStake),
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('Partial-paused')
      })
      it('should not allow transferring but leaving less than the minimum indexer stake', async function () {
        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            tokensToStake.sub(minimumIndexerStake).add(1),
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('!minimumIndexerStake remaining')
      })
      it('should not allow transferring less than the minimum indexer stake the first time', async function () {
        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake.sub(1),
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('!minimumIndexerStake sent')
      })
      it('should not allow transferring if there are tokens locked for withdrawal', async function () {
        await staking.connect(indexer.signer).unstake(tokensToStake)
        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            tokensToStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('tokensLocked != 0')
      })
      it('should not allow transferring to a beneficiary that is address zero', async function () {
        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(AddressZero, tokensToStake, maxGas, gasPriceBid, maxSubmissionCost, {
            value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
          })
        await expect(tx).revertedWith('l2Beneficiary == 0')
      })
      it('should not allow transferring the whole stake if there are open allocations', async function () {
        await allocate(toGRT('10'))
        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            tokensToStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('allocated')
      })
      it('should not allow transferring partial stake if the remaining indexer capacity is insufficient for open allocations', async function () {
        // We set delegation ratio == 1 so an indexer can only use as much delegation as their own stake
        await staking.connect(governor.signer).setDelegationRatio(1)
        const tokensToDelegate = toGRT('202100')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)

        // Now the indexer has 200k tokens staked and 200k tokens delegated
        await allocate(toGRT('400000'))

        // But if we try to transfer even 100k, we will not have enough indexer capacity to cover the open allocation
        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            toGRT('100000'),
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('! allocation capacity')
      })
      it('should not allow transferring if the ETH sent is more than required', async function () {
        const tx = staking
          .connect(indexer.signer)
          .transferStakeToL2(
            indexer.address,
            tokensToStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)).add(1),
            },
          )
        await expect(tx).revertedWith('INVALID_ETH_AMOUNT')
      })
      it('sends the tokens and a message through the L1GraphTokenGateway', async function () {
        const amountToSend = minimumIndexerStake
        await shouldTransferIndexerStake(amountToSend)
        // Check that the indexer stake was reduced by the sent amount
        expect((await staking.stakes(indexer.address)).tokensStaked).to.equal(
          tokensToStake.sub(amountToSend),
        )
      })
      it('should allow transferring the whole stake if there are no open allocations', async function () {
        await shouldTransferIndexerStake(tokensToStake)
        // Check that the indexer stake was reduced by the sent amount
        expect((await staking.stakes(indexer.address)).tokensStaked).to.equal(0)
      })
      it('should allow transferring partial stake if the remaining capacity can cover the allocations', async function () {
        // We set delegation ratio == 1 so an indexer can only use as much delegation as their own stake
        await staking.connect(governor.signer).setDelegationRatio(1)
        const tokensToDelegate = toGRT('200000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)

        // Now the indexer has 200k tokens staked and 200k tokens delegated,
        // but they allocate 200k
        await allocate(toGRT('200000'))

        // If we transfer 100k, we will still have enough indexer capacity to cover the open allocation
        const amountToSend = toGRT('100000')
        await shouldTransferIndexerStake(amountToSend)
        // Check that the indexer stake was reduced by the sent amount
        expect((await staking.stakes(indexer.address)).tokensStaked).to.equal(
          tokensToStake.sub(amountToSend),
        )
      })
      it('allows transferring several times to the same beneficiary', async function () {
        // Stake a bit more so we're still over the minimum stake after transferring twice
        await staking.connect(indexer.signer).stake(tokensToStake)
        await shouldTransferIndexerStake(minimumIndexerStake)
        await shouldTransferIndexerStake(toGRT('1000'), { expectedSeqNum: 2 })
        expect((await staking.stakes(indexer.address)).tokensStaked).to.equal(
          tokensToStake.mul(2).sub(minimumIndexerStake).sub(toGRT('1000')),
        )
      })
      it('should not allow transferring to a different beneficiary the second time', async function () {
        await shouldTransferIndexerStake(minimumIndexerStake)
        const tx = staking.connect(indexer.signer).transferStakeToL2(
          indexer.address, // Note this is different from l2Indexer used before
          minimumIndexerStake,
          maxGas,
          gasPriceBid,
          maxSubmissionCost,
          {
            value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
          },
        )
        await expect(tx).revertedWith('l2Beneficiary != previous')
      })
    })

    describe('transferLockedStakeToL2', function () {
      it('should not allow transferring if the protocol is partially paused', async function () {
        await controller.setPartialPaused(true)

        const tx = staking
          .connect(indexer.signer)
          .transferLockedStakeToL2(minimumIndexerStake, maxGas, gasPriceBid, maxSubmissionCost)
        await expect(tx).revertedWith('Partial-paused')
      })
      it('sends a message through L1GraphTokenGateway like transferStakeToL2, but gets the beneficiary and ETH from a transfer tool contract', async function () {
        const amountToSend = minimumIndexerStake

        await l1GraphTokenLockTransferTool.setL2WalletAddress(indexer.address, l2Indexer.address)
        const oldTransferToolEthBalance = await provider().getBalance(
          l1GraphTokenLockTransferTool.address,
        )
        const tx = staking
          .connect(indexer.signer)
          .transferLockedStakeToL2(minimumIndexerStake, maxGas, gasPriceBid, maxSubmissionCost)
        const expectedFunctionData = defaultAbiCoder.encode(
          ['tuple(address)'],
          [[l2Indexer.address]],
        )

        const expectedCallhookData = defaultAbiCoder.encode(
          ['uint8', 'bytes'],
          [toBN(0), expectedFunctionData], // code = 0 means RECEIVE_INDEXER_CODE
        )
        const expectedL2Data = await l1GraphTokenGateway.getOutboundCalldata(
          grt.address,
          staking.address,
          mockL2Staking.address,
          amountToSend,
          expectedCallhookData,
        )

        await expect(tx)
          .emit(l1GraphTokenGateway, 'TxToL2')
          .withArgs(staking.address, mockL2Gateway.address, toBN(1), expectedL2Data)
        expect(await provider().getBalance(l1GraphTokenLockTransferTool.address)).to.equal(
          oldTransferToolEthBalance.sub(maxSubmissionCost).sub(gasPriceBid.mul(maxGas)),
        )
      })
      it('should not allow transferring if the transfer tool contract returns a zero address beneficiary', async function () {
        const tx = staking
          .connect(indexer.signer)
          .transferLockedStakeToL2(minimumIndexerStake, maxGas, gasPriceBid, maxSubmissionCost)
        await expect(tx).revertedWith('LOCK NOT TRANSFERRED')
      })
      it('should not allow transferring if the transfer tool contract does not provide enough ETH', async function () {
        await staking
          .connect(governor.signer)
          .setL1GraphTokenLockTransferTool(l1GraphTokenLockTransferToolBad.address)
        await l1GraphTokenLockTransferToolBad.setL2WalletAddress(indexer.address, l2Indexer.address)
        const tx = staking
          .connect(indexer.signer)
          .transferLockedStakeToL2(minimumIndexerStake, maxGas, gasPriceBid, maxSubmissionCost)
        await expect(tx).revertedWith('ETH TRANSFER FAILED')
      })
    })
    describe('unlockDelegationToTransferredIndexer', function () {
      beforeEach(async function () {
        await staking.connect(governor.signer).setDelegationUnbondingPeriod(28) // epochs
      })
      it('allows a delegator to a transferred indexer to withdraw locked delegation before the unbonding period', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        const actualDelegation = tokensToDelegate.sub(
          tokensToDelegate.mul(delegationTaxPPM).div(1000000),
        )
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            tokensToStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await staking.connect(delegator.signer).undelegate(indexer.address, actualDelegation)
        const tx = await staking
          .connect(delegator.signer)
          .unlockDelegationToTransferredIndexer(indexer.address)
        await expect(tx)
          .emit(staking, 'StakeDelegatedUnlockedDueToL2Transfer')
          .withArgs(indexer.address, delegator.address)
        const tx2 = await staking
          .connect(delegator.signer)
          .withdrawDelegated(indexer.address, AddressZero)
        await expect(tx2)
          .emit(staking, 'StakeDelegatedWithdrawn')
          .withArgs(indexer.address, delegator.address, actualDelegation)
      })
      it('rejects calls if the protocol is partially paused', async function () {
        await controller.setPartialPaused(true)

        const tx = staking
          .connect(delegator.signer)
          .unlockDelegationToTransferredIndexer(indexer.address)
        await expect(tx).revertedWith('Partial-paused')
      })
      it('rejects calls if the indexer has not transferred their stake to L2', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        const tx = staking
          .connect(delegator.signer)
          .unlockDelegationToTransferredIndexer(indexer.address)
        await expect(tx).revertedWith('indexer not transferred')
      })
      it('rejects calls if the indexer has only transferred part of their stake but not all', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        const tx = staking
          .connect(delegator.signer)
          .unlockDelegationToTransferredIndexer(indexer.address)
        await expect(tx).revertedWith('indexer not transferred')
      })
      it('rejects calls if the delegator has not undelegated first', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            tokensToStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        const tx = staking
          .connect(delegator.signer)
          .unlockDelegationToTransferredIndexer(indexer.address)
        await expect(tx).revertedWith('! locked')
      })
      it('rejects calls if the caller is not a delegator', async function () {
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            tokensToStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        const tx = staking
          .connect(delegator.signer)
          .unlockDelegationToTransferredIndexer(indexer.address)
        // The function checks for tokensLockedUntil so this is the error we should get:
        await expect(tx).revertedWith('! locked')
      })
    })
    describe('transferDelegationToL2', function () {
      it('rejects calls if the protocol is partially paused', async function () {
        await controller.setPartialPaused(true)

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('Partial-paused')
      })
      it('rejects calls if the delegated indexer has not transferred stake to L2', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('indexer not transferred')
      })
      it('rejects calls if the beneficiary is zero', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            AddressZero,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('l2Beneficiary == 0')
      })
      it('rejects calls if the delegator has tokens locked for undelegation', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await staking.connect(delegator.signer).undelegate(indexer.address, toGRT('1'))

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('tokensLocked != 0')
      })
      it('rejects calls if the delegator has no tokens delegated to the indexer', async function () {
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('delegation == 0')
      })
      it('sends all the tokens delegated to the indexer to the beneficiary on L2, using the gateway', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        const actualDelegation = tokensToDelegate.sub(
          tokensToDelegate.mul(delegationTaxPPM).div(1000000),
        )
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        const expectedFunctionData = defaultAbiCoder.encode(
          ['tuple(address,address)'],
          [[l2Indexer.address, l2Delegator.address]],
        )

        const expectedCallhookData = defaultAbiCoder.encode(
          ['uint8', 'bytes'],
          [toBN(1), expectedFunctionData], // code = 1 means RECEIVE_DELEGATION_CODE
        )
        const expectedL2Data = await l1GraphTokenGateway.getOutboundCalldata(
          grt.address,
          staking.address,
          mockL2Staking.address,
          actualDelegation,
          expectedCallhookData,
        )

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        // seqNum is 2 because the first bridge call was in transferStakeToL2
        await expect(tx)
          .emit(l1GraphTokenGateway, 'TxToL2')
          .withArgs(staking.address, mockL2Gateway.address, toBN(2), expectedL2Data)
        await expect(tx)
          .emit(staking, 'DelegationTransferredToL2')
          .withArgs(
            delegator.address,
            l2Delegator.address,
            indexer.address,
            l2Indexer.address,
            actualDelegation,
          )
      })
      it('sets the delegation shares to zero so cannot be called twice', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        await staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx).revertedWith('delegation == 0')
      })
      it('can be called again if the delegator added more delegation (edge case)', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        const actualDelegation = tokensToDelegate.sub(
          tokensToDelegate.mul(delegationTaxPPM).div(1000000),
        )
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        await staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await expect(tx)
          .emit(staking, 'DelegationTransferredToL2')
          .withArgs(
            delegator.address,
            l2Delegator.address,
            indexer.address,
            l2Indexer.address,
            actualDelegation,
          )
      })
      it('rejects calls if the ETH value is larger than expected', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        const tx = staking
          .connect(delegator.signer)
          .transferDelegationToL2(
            indexer.address,
            l2Delegator.address,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)).add(1),
            },
          )
        await expect(tx).revertedWith('INVALID_ETH_AMOUNT')
      })
    })
    describe('transferLockedDelegationToL2', function () {
      it('rejects calls if the protocol is partially paused', async function () {
        await controller.setPartialPaused(true)

        const tx = staking
          .connect(delegator.signer)
          .transferLockedDelegationToL2(indexer.address, maxGas, gasPriceBid, maxSubmissionCost)
        await expect(tx).revertedWith('Partial-paused')
      })
      it('sends delegated tokens to L2 like transferDelegationToL2, but gets the beneficiary and ETH from the L1GraphTokenLockTransferTool', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)
        const actualDelegation = tokensToDelegate.sub(
          tokensToDelegate.mul(delegationTaxPPM).div(1000000),
        )

        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        const expectedFunctionData = defaultAbiCoder.encode(
          ['tuple(address,address)'],
          [[l2Indexer.address, l2Delegator.address]],
        )

        const expectedCallhookData = defaultAbiCoder.encode(
          ['uint8', 'bytes'],
          [toBN(1), expectedFunctionData], // code = 1 means RECEIVE_DELEGATION_CODE
        )
        const expectedL2Data = await l1GraphTokenGateway.getOutboundCalldata(
          grt.address,
          staking.address,
          mockL2Staking.address,
          actualDelegation,
          expectedCallhookData,
        )

        await l1GraphTokenLockTransferTool.setL2WalletAddress(
          delegator.address,
          l2Delegator.address,
        )

        const oldTransferToolEthBalance = await provider().getBalance(
          l1GraphTokenLockTransferTool.address,
        )
        const tx = staking
          .connect(delegator.signer)
          .transferLockedDelegationToL2(indexer.address, maxGas, gasPriceBid, maxSubmissionCost)
        // seqNum is 2 because the first bridge call was in transferStakeToL2
        await expect(tx)
          .emit(l1GraphTokenGateway, 'TxToL2')
          .withArgs(staking.address, mockL2Gateway.address, toBN(2), expectedL2Data)
        await expect(tx)
          .emit(staking, 'DelegationTransferredToL2')
          .withArgs(
            delegator.address,
            l2Delegator.address,
            indexer.address,
            l2Indexer.address,
            actualDelegation,
          )
        expect(await provider().getBalance(l1GraphTokenLockTransferTool.address)).to.equal(
          oldTransferToolEthBalance.sub(maxSubmissionCost).sub(gasPriceBid.mul(maxGas)),
        )
      })
      it('rejects calls if the transfer tool contract returns a zero address beneficiary', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)

        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )

        const tx = staking
          .connect(delegator.signer)
          .transferLockedDelegationToL2(indexer.address, maxGas, gasPriceBid, maxSubmissionCost)
        await expect(tx).revertedWith('LOCK NOT TRANSFERRED')
      })
      it('rejects calls if the transfer tool contract does not provide enough ETH', async function () {
        const tokensToDelegate = toGRT('10000')
        await staking.connect(delegator.signer).delegate(indexer.address, tokensToDelegate)

        await staking
          .connect(indexer.signer)
          .transferStakeToL2(
            l2Indexer.address,
            minimumIndexerStake,
            maxGas,
            gasPriceBid,
            maxSubmissionCost,
            {
              value: maxSubmissionCost.add(gasPriceBid.mul(maxGas)),
            },
          )
        await staking
          .connect(governor.signer)
          .setL1GraphTokenLockTransferTool(l1GraphTokenLockTransferToolBad.address)

        await l1GraphTokenLockTransferToolBad.setL2WalletAddress(
          delegator.address,
          l2Delegator.address,
        )
        const tx = staking
          .connect(delegator.signer)
          .transferLockedDelegationToL2(indexer.address, maxGas, gasPriceBid, maxSubmissionCost)
        await expect(tx).revertedWith('ETH TRANSFER FAILED')
      })
    })
  })
})
