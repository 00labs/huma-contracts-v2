// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {Errors} from "../common/Errors.sol";
import {PoolConfig, LPConfig} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE} from "../common/SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {ICreditManager} from "../credit/interfaces/ICreditManager.sol";
import {ICredit} from "../credit/interfaces/ICredit.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Pool
 * @notice Pool is a core contract that connects the lender side (via Tranches)
 * and the borrower side (via Credit).
 */
contract Pool is PoolConfigCache, IPool {
    struct TranchesAssets {
        uint96 seniorTotalAssets; // total assets of senior tranche
        uint96 juniorTotalAssets; // total assets of junior tranche
    }

    struct TranchesLosses {
        uint96 seniorLoss; // total losses of senior tranche
        uint96 juniorLoss; // total losses of junior tranche
    }

    enum PoolStatus {
        Off,
        On
    }

    IEpochManager public epochManager;
    IFirstLossCover[] internal _firstLossCovers;
    IPoolFeeManager public feeManager;
    IPoolSafe public poolSafe;
    ITranchesPolicy public tranchesPolicy;
    ICredit public credit;
    ICreditManager public creditManager;

    TranchesAssets public tranchesAssets;
    TranchesLosses public tranchesLosses;

    // Whether the pool is ON or OFF
    PoolStatus internal _status;

    bool public readyForFirstLossCoverWithdrawal;

    /**
     * @notice The pool has been disabled.
     * @param by The address that disabled the pool.
     */
    event PoolDisabled(address indexed by);

    /**
     * @notice The pool has been enabled.
     * @param by The address that enabled the pool.
     */
    event PoolEnabled(address indexed by);

    /**
     * @notice The ready for first loss cover withdrawal status has been updated.
     * @param by The address that updated the status.
     * @param ready Whether the pool is now ready for first loss cover withdrawal.
     */
    event PoolReadyForFirstLossCoverWithdrawal(address indexed by, bool ready);

    event PoolAssetsRefreshed(
        uint256 refreshedTimestamp,
        uint256 profit,
        uint256 loss,
        uint256 lossRecovery,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );

    /**
     * @notice Pool profit has been distributed.
     * @param profit The amount of profit distributed.
     * @param seniorTotalAssets The total amount of senior assets post profit distribution.
     * @param juniorTotalAssets The total amount of junior assets post profit distribution.
     */
    event ProfitDistributed(uint256 profit, uint256 seniorTotalAssets, uint256 juniorTotalAssets);

    /**
     * @notice Loss has been distributed.
     * @param seniorTotalAssets The total amount of senior assets post loss distribution.
     * @param juniorTotalAssets The total amount of junior assets post loss distribution.
     * @param seniorTotalLoss The total amount of loss the the senior tranche suffered post loss distribution.
     * @param juniorTotalLoss The total amount of loss the the junior tranche suffered post loss distribution.
     */
    event LossDistributed(
        uint256 loss,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );

    /**
     * @notice Loss recovery has been distributed.
     * @param seniorTotalAssets The total amount of senior assets post loss recovery distribution.
     * @param juniorTotalAssets The total amount of junior assets post loss recovery distribution.
     * @param seniorTotalLoss The remaining amount of loss the the senior tranche suffered post loss recovery
     * distribution.
     * @param juniorTotalLoss The remaining amount of loss the the junior tranche suffered post loss recovery
     * distribution.
     */
    event LossRecoveryDistributed(
        uint256 lossRecovery,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );

    /**
     * @notice Turns on the pool. Before a pool is turned on, the required first loss cover
     * and tranche liquidity must be deposited first.
     * @custom:access Only the pool owner or protocol owner can enable a pool.
     */
    function enablePool() external {
        poolConfig.onlyPoolOwnerOrHumaOwner(msg.sender);
        poolConfig.checkFirstLossCoverRequirementsForAdmin();
        poolConfig.checkLiquidityRequirements();

        epochManager.startNewEpoch();
        _status = PoolStatus.On;
        emit PoolEnabled(msg.sender);
    }

    /**
     * @notice Disables the pool. Once a pool is disabled, no money moves in or out.
     * @custom:access Any pool operator can disable a pool. Only the pool owner or Huma protocol
     * owner can enable it again.
     */
    function disablePool() external {
        poolConfig.onlyPoolOperator(msg.sender);
        _status = PoolStatus.Off;
        emit PoolDisabled(msg.sender);
    }

    /**
     * @notice Enables or disables the first loss cover investors to withdraw capital.
     * @custom:access Only pool owner or Huma protocol owner can call this function.
     */
    function setReadyForFirstLossCoverWithdrawal(bool isReady) external {
        poolConfig.onlyPoolOwnerOrHumaOwner(msg.sender);
        readyForFirstLossCoverWithdrawal = isReady;
        emit PoolReadyForFirstLossCoverWithdrawal(msg.sender, isReady);
    }

    /// @inheritdoc IPool
    /// @custom:access Only Credit or CreditManager contract can call this function.
    function distributeProfit(uint256 profit) external {
        _onlyCreditOrCreditManager(msg.sender);
        _distributeProfit(profit);
    }

    /// @inheritdoc IPool
    /// @custom:access Only Credit or CreditManager contract can call this function.
    function distributeLoss(uint256 loss) external {
        _onlyCreditOrCreditManager(msg.sender);
        _distributeLoss(loss);
    }

    /// @inheritdoc IPool
    /// @custom:access Only Credit contract can call this function
    function distributeLossRecovery(uint256 lossRecovery) external {
        if (msg.sender != address(credit)) revert Errors.AuthorizedContractCallerRequired();
        _distributeLossRecovery(lossRecovery);
    }

    /// @inheritdoc IPool
    /// @custom:access Only TrancheVault or Epoch Manager can call this function
    function updateTranchesAssets(uint96[2] memory assets) external {
        _onlyTrancheVaultOrEpochManager(msg.sender);
        _updateTranchesAssets(assets);
    }

    /// @inheritdoc IPool
    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[index];
    }

    /// @inheritdoc IPool
    function isPoolOn() external view returns (bool status) {
        return _status == PoolStatus.On;
    }

    /// @inheritdoc IPool
    function getTrancheAvailableCap(uint256 index) external view returns (uint256 availableCap) {
        if (index != SENIOR_TRANCHE && index != JUNIOR_TRANCHE) return 0;
        LPConfig memory config = poolConfig.getLPConfig();
        uint96[2] memory assets = currentTranchesAssets();
        uint256 poolAssets = assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
        availableCap = config.liquidityCap > poolAssets ? config.liquidityCap - poolAssets : 0;
        if (index == SENIOR_TRANCHE) {
            // The available cap for the senior tranche is subject to the additional constraint of the
            // max senior : junior asset ratio, i.e. the total assets in the senior tranche must not exceed
            // assets[JUNIOR_TRANCHE] * maxSeniorJuniorRatio at all times. Note that if this value is less than
            // the current total senior assets (i.e. in the case of default), then the senior available cap is 0.
            uint256 seniorAvailableCap = Math.max(
                assets[JUNIOR_TRANCHE] * config.maxSeniorJuniorRatio,
                assets[SENIOR_TRANCHE]
            ) - assets[SENIOR_TRANCHE];
            availableCap = availableCap > seniorAvailableCap ? seniorAvailableCap : availableCap;
        }
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }

    /// @inheritdoc IPool
    function totalAssets() public view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
    }

    /// @inheritdoc IPool
    function currentTranchesAssets() public view returns (uint96[2] memory assets) {
        TranchesAssets memory tempTranchesAssets = tranchesAssets;
        return [tempTranchesAssets.seniorTotalAssets, tempTranchesAssets.juniorTotalAssets];
    }

    /**
     * @notice Common function in Huma protocol to retrieve contract addresses from PoolConfig.
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.tranchesPolicy();
        assert(addr != address(0));
        tranchesPolicy = ITranchesPolicy(addr);

        addr = _poolConfig.poolFeeManager();
        assert(addr != address(0));
        feeManager = IPoolFeeManager(addr);

        addr = _poolConfig.epochManager();
        assert(addr != address(0));
        epochManager = IEpochManager(addr);

        addr = _poolConfig.credit();
        assert(addr != address(0));
        credit = ICredit(addr);

        addr = _poolConfig.creditManager();
        assert(addr != address(0));
        creditManager = ICreditManager(addr);

        delete _firstLossCovers;
        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            if (covers[i] != address(0)) {
                _firstLossCovers.push(IFirstLossCover(covers[i]));
            }
        }
    }

    /**
     * @notice Internal function that distributes profit to admins, senior and junior tranches,
     * and first loss covers in this sequence.
     * @param profit The amount of profit to be distributed.
     * @custom:access Internal function without access restriction. Caller needs to control access.
     */
    function _distributeProfit(uint256 profit) internal {
        TranchesAssets memory assets = tranchesAssets;

        // Distributes to pool admins first.
        uint256 poolProfit = feeManager.distributePoolFees(profit);

        if (poolProfit > 0) {
            (
                uint256[2] memory profitsForTrancheVaults,
                uint256[] memory profitsForFirstLossCovers
            ) = tranchesPolicy.distProfitToTranches(
                    poolProfit,
                    [assets.seniorTotalAssets, assets.juniorTotalAssets]
                );
            uint256[2] memory newAssets;
            newAssets[SENIOR_TRANCHE] =
                assets.seniorTotalAssets +
                profitsForTrancheVaults[SENIOR_TRANCHE];
            poolSafe.addUnprocessedProfit(
                poolConfig.seniorTranche(),
                profitsForTrancheVaults[SENIOR_TRANCHE]
            );
            newAssets[JUNIOR_TRANCHE] = assets.juniorTotalAssets;
            if (profitsForTrancheVaults[JUNIOR_TRANCHE] > 0) {
                newAssets[JUNIOR_TRANCHE] += profitsForTrancheVaults[JUNIOR_TRANCHE];
                poolSafe.addUnprocessedProfit(
                    poolConfig.juniorTranche(),
                    profitsForTrancheVaults[JUNIOR_TRANCHE]
                );
            }

            uint256 len = profitsForFirstLossCovers.length;
            for (uint256 i = 0; i < len; i++) {
                if (profitsForFirstLossCovers[i] == 0) {
                    continue;
                }
                IFirstLossCover cover = _firstLossCovers[i];
                cover.addCoverAssets(profitsForFirstLossCovers[i]);
            }

            // Don't call _updateTranchesAssets() here because yield tracker has already
            // been updated in distProfitToTranches().
            tranchesAssets = TranchesAssets({
                seniorTotalAssets: uint96(newAssets[SENIOR_TRANCHE]),
                juniorTotalAssets: uint96(newAssets[JUNIOR_TRANCHE])
            });
            emit ProfitDistributed(profit, newAssets[SENIOR_TRANCHE], newAssets[JUNIOR_TRANCHE]);
        }
    }

    /**
     * @notice Utility function that distributes loss to first loss covers and tranches.
     * The loss is distributed to first loss covers first, then the junior tranche, and the senior tranche last.
     * @param loss The amount of loss to be distributed.
     * @custom:access Internal function without access restriction. Caller needs to control access.
     */
    function _distributeLoss(uint256 loss) internal {
        if (loss > 0) {
            uint256 coverCount = _firstLossCovers.length;
            for (uint256 i = 0; i < coverCount && loss > 0; i++) {
                loss = _firstLossCovers[i].coverLoss(loss);
            }

            if (loss > 0) {
                // If there are losses remaining, let the junior and senior tranches cover the losses.
                _distLossToTranches(loss);
            }
        }
    }

    /**
     * @notice Distributes loss to tranches.
     * @param loss The amount of loss to distribute.
     */
    function _distLossToTranches(uint256 loss) internal {
        TranchesAssets memory assets = tranchesAssets;
        uint256 juniorTotalAssets = assets.juniorTotalAssets;
        // Distribute losses to the junior tranche up to the total junior asset.
        uint256 juniorLoss = juniorTotalAssets >= loss ? loss : juniorTotalAssets;
        // When triggering default, since we distribute profit right before distributing loss,
        // `loss - juniorLoss` could surpass the total assets of the senior tranche in the following two scenarios:
        // 1. Admins earn fees during profit distribution, but the fees do not explicitly participate in
        //    loss distribution.
        // 2. Theoretically, first loss covers could be configured to take on more profit than loss when
        //    default is triggered, and the additional loss would fall on tranches. However, this is extremely unlikely.
        // Therefore, we need to cap the loss at the senior total assets. It's important to note
        // that borrowers' payment obligations are based on the total amount due in `CreditRecord`, thus omitting to
        // fully account for losses in the senior tranche does not reduce the amount the borrower is required to pay.
        uint256 seniorLoss = Math.min(assets.seniorTotalAssets, loss - juniorLoss);

        assets.seniorTotalAssets -= uint96(seniorLoss);
        assets.juniorTotalAssets -= uint96(juniorLoss);
        _updateTranchesAssets([assets.seniorTotalAssets, assets.juniorTotalAssets]);
        TranchesLosses memory losses = tranchesLosses;
        losses.seniorLoss += uint96(seniorLoss);
        losses.juniorLoss += uint96(juniorLoss);
        tranchesLosses = losses;

        emit LossDistributed(
            loss,
            assets.seniorTotalAssets,
            assets.juniorTotalAssets,
            losses.seniorLoss,
            losses.juniorLoss
        );
    }

    /**
     * @notice Utility function that distributes loss recovery to different tranches and
     * First Loss Covers (FLCs). The distribution sequence is: senior tranche, junior tranche,
     * followed by FLCs.
     * @param lossRecovery The amount of loss to be distributed.
     * @custom:access Internal function without access restriction. Caller needs to control access.
     */
    function _distributeLossRecovery(uint256 lossRecovery) internal {
        if (lossRecovery > 0) {
            uint256 remainingLossRecovery = _distLossRecoveryToTranches(lossRecovery);

            // Distributes the remainder to First Loss Covers.
            uint256 numFirstLossCovers = _firstLossCovers.length;
            for (uint256 i = 0; i < numFirstLossCovers && remainingLossRecovery > 0; i++) {
                IFirstLossCover cover = _firstLossCovers[numFirstLossCovers - i - 1];
                remainingLossRecovery = cover.recoverLoss(remainingLossRecovery);
            }
        }
    }

    /**
     * @notice Distributes loss recovery to tranches.
     * @param lossRecovery The loss recovery amount.
     * @return remainingLossRecovery The remaining loss recovery after distributing among tranches.
     */
    function _distLossRecoveryToTranches(
        uint256 lossRecovery
    ) internal returns (uint256 remainingLossRecovery) {
        TranchesAssets memory assets = tranchesAssets;
        TranchesLosses memory losses = tranchesLosses;
        uint96 seniorLoss = losses.seniorLoss;
        // Allocates recovery to senior first, up to the total senior losses
        uint256 seniorLossRecovery = lossRecovery >= seniorLoss ? seniorLoss : lossRecovery;
        if (seniorLossRecovery > 0) {
            assets.seniorTotalAssets += uint96(seniorLossRecovery);
            losses.seniorLoss -= uint96(seniorLossRecovery);
        }

        remainingLossRecovery = lossRecovery - seniorLossRecovery;
        if (remainingLossRecovery > 0) {
            uint96 juniorLoss = losses.juniorLoss;
            uint256 juniorLossRecovery = remainingLossRecovery >= juniorLoss
                ? juniorLoss
                : remainingLossRecovery;
            assets.juniorTotalAssets += uint96(juniorLossRecovery);
            losses.juniorLoss -= uint96(juniorLossRecovery);
            remainingLossRecovery = remainingLossRecovery - juniorLossRecovery;
        }

        tranchesLosses = losses;

        _updateTranchesAssets([assets.seniorTotalAssets, assets.juniorTotalAssets]);

        emit LossRecoveryDistributed(
            lossRecovery - remainingLossRecovery,
            assets.seniorTotalAssets,
            assets.juniorTotalAssets,
            losses.seniorLoss,
            losses.juniorLoss
        );

        return remainingLossRecovery;
    }

    /**
     * @notice Utility function to update tranche assets.
     * @param assets The array that represents the desired tranche asset.
     * @custom:access Internal function without access restriction. Caller needs to control access.
     */
    function _updateTranchesAssets(uint96[2] memory assets) internal {
        tranchesAssets = TranchesAssets({
            seniorTotalAssets: assets[SENIOR_TRANCHE],
            juniorTotalAssets: assets[JUNIOR_TRANCHE]
        });
        tranchesPolicy.refreshYieldTracker(assets);
    }

    function _onlyTrancheVaultOrEpochManager(address account) internal view {
        if (
            account != poolConfig.juniorTranche() &&
            account != poolConfig.seniorTranche() &&
            account != poolConfig.epochManager()
        ) revert Errors.AuthorizedContractCallerRequired();
    }

    function _onlyCreditOrCreditManager(address account) internal view {
        if (account != address(credit) && account != address(creditManager)) {
            revert Errors.AuthorizedContractCallerRequired();
        }
    }
}
