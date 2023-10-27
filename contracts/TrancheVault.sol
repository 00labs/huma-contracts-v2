// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
import {TrancheVaultStorage, IERC20} from "./TrancheVaultStorage.sol";
import {IEpoch, EpochInfo} from "./interfaces/IEpoch.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

contract TrancheVault is
    AccessControlUpgradeable,
    ERC20Upgradeable,
    PoolConfigCache,
    TrancheVaultStorage,
    IEpoch
{
    bytes32 public constant LENDER_ROLE = keccak256("LENDER");

    event EpochProcessed(
        uint256 indexed epochId,
        uint256 sharesRequested,
        uint256 sharesProcessed,
        uint256 amountProcessed
    );

    event LiquidityDeposited(address indexed account, uint256 assetAmount, uint256 shareAmount);

    event LenderFundDisbursed(address indexed account, address receiver, uint256 withdrawnAmount);

    event RedemptionRequestAdded(address indexed account, uint256 shareAmount, uint256 epochId);

    event RedemptionRequestRemoved(address indexed account, uint256 shareAmount, uint256 epochId);

    constructor() {
        // _disableInitializers();
    }

    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external initializer {
        __ERC20_init(name, symbol);
        __AccessControl_init();
        _initialize(_poolConfig);

        if (seniorTrancheOrJuniorTranche > 1) revert Errors.invalidTrancheIndex();
        trancheIndex = seniorTrancheOrJuniorTranche;
    }

    /**
     * Gets address for underlyingToken, pool, poolSafe, and epochManager from poolConfig
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);
        _decimals = IERC20MetadataUpgradeable(addr).decimals();

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.epochManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = IEpochManager(addr);
    }

    /**
     * @notice Lenders need to pass compliance requirements. Pool operator will administer off-chain
     * to make sure potential lenders meet the requirements. Afterwards, the pool operator will
     * call this function to mark a lender as approved.
     */
    function addApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        _grantRole(LENDER_ROLE, lender);
    }

    /**
     * @notice Removes a lender. This prevents the lender from making more deposits.
     * The capital that the lender has contributed can continue to work as normal.
     */
    function removeApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        _revokeRole(LENDER_ROLE, lender);
    }

    /// @inheritdoc IEpoch
    function currentEpochInfo() external view override returns (EpochInfo memory epochInfo) {
        uint256 epochId = epochManager.currentEpochId();
        epochInfo = epochInfoByEpochId[epochId];
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalSupply() public view override returns (uint256) {
        return ERC20Upgradeable.totalSupply();
    }

    /// @inheritdoc IEpoch
    function executeEpoch(EpochInfo memory epochProcessed) external {
        _onlyEpochManager(msg.sender);

        if (epochProcessed.totalSharesProcessed > 0) {
            epochInfoByEpochId[epochProcessed.epochId] = epochProcessed;
            // Burn processed shares of LP tokens.
            ERC20Upgradeable._burn(address(this), epochProcessed.totalSharesProcessed);
            // Withdraw underlying tokens from the reserve so that LPs can redeem.
            poolSafe.withdraw(address(this), epochProcessed.totalAmountProcessed);
        }

        uint256 unprocessed = epochProcessed.totalSharesRequested -
            epochProcessed.totalSharesProcessed;

        if (unprocessed > 0) {
            // Move unprocessed redemption to next epoch
            EpochInfo memory nextEpochInfo = EpochInfo({
                epochId: epochProcessed.epochId + 1,
                totalSharesRequested: uint96(unprocessed),
                totalSharesProcessed: 0,
                totalAmountProcessed: 0
            });
            epochInfoByEpochId[nextEpochInfo.epochId] = nextEpochInfo;
            epochIds.push(nextEpochInfo.epochId);
        }

        emit EpochProcessed(
            epochProcessed.epochId,
            epochProcessed.totalSharesRequested,
            epochProcessed.totalSharesProcessed,
            epochProcessed.totalAmountProcessed
        );
    }

    /**
     * @notice Allows the pool owner and EA to make initial deposit before the pool goes live
     * @param assets The amount of underlyingTokens to be deposited
     */
    function makeInitialDeposit(uint256 assets) external returns (uint256 shares) {
        _onlyAuthorizedInitialDepositor(msg.sender);
        return _deposit(assets, msg.sender);
    }

    /**
     * @notice LP deposits to the pool to earn interest, and share losses
     *
     * @notice All deposits should be made by calling this function and
     * makeInitialDeposit() (for pool owner and EA's initial deposit) only.
     * Please do NOT directly transfer any digital assets to the contracts,
     * which will cause a permanent loss and we cannot help reverse transactions
     * or retrieve assets from the contracts.
     *
     * @param assets The number of underlyingTokens to be deposited
     * @param receiver The address to receive the minted tranche token
     * @return shares The number of tranche token to be minted
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        _onlyLender(msg.sender);
        _onlyLender(receiver);
        poolConfig.onlyProtocolAndPoolOn();
        return _deposit(assets, receiver);
    }

    function _deposit(uint256 assets, address receiver) internal returns (uint256 shares) {
        uint256 cap = poolConfig.getTrancheLiquidityCap(trancheIndex);
        if (assets > cap) {
            revert Errors.poolLiquidityCapExceeded();
        }
        uint96[2] memory tranches = pool.refreshPool();
        uint256 trancheAssets = tranches[trancheIndex];
        if (trancheAssets + assets > cap) {
            revert Errors.poolLiquidityCapExceeded();
        }

        if (trancheIndex == SENIOR_TRANCHE) {
            // Make sure that the max senior : junior asset ratio is still valid.
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            if (
                (trancheAssets + assets) > tranches[JUNIOR_TRANCHE] * lpConfig.maxSeniorJuniorRatio
            ) revert Errors.maxSeniorJuniorRatioExceeded();
        }

        poolSafe.deposit(msg.sender, assets);

        shares = _convertToShares(assets, trancheAssets);
        ERC20Upgradeable._mint(receiver, shares);

        tranches[trancheIndex] += uint96(assets);
        pool.updateTranchesAssets(tranches);

        emit LiquidityDeposited(receiver, assets, shares);
    }

    /**
     * @notice Records a new redemption request.
     * @param shares The number of shares the lender wants to redeem
     */
    function addRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        poolConfig.checkFirstLossCoverRequirementsForRedemption(msg.sender);
        uint256 sharesBalance = ERC20Upgradeable.balanceOf(msg.sender);
        if (shares > sharesBalance) {
            revert Errors.insufficientSharesForRequest();
        }
        uint256 assetsAfterRedemption = convertToAssets(sharesBalance - shares);
        poolConfig.checkLiquidityRequirementForRedemption(
            msg.sender,
            address(this),
            assetsAfterRedemption
        );

        uint256 currentEpochId = epochManager.currentEpochId();
        EpochInfo memory curEpochInfo = epochInfoByEpochId[currentEpochId];
        if (curEpochInfo.totalSharesRequested > 0) {
            // If the current epoch already has redemption requests, then add the new redemption request
            // to it.
            curEpochInfo.totalSharesRequested += uint96(shares);
        } else {
            // Otherwise, record the current epoch ID in `epochIds` since there are now redemption requests,
            // and record the redemption request data in the global registry.
            epochIds.push(currentEpochId);
            curEpochInfo.epochId = uint64(currentEpochId);
            curEpochInfo.totalSharesRequested = uint96(shares);
        }
        epochInfoByEpochId[currentEpochId] = curEpochInfo;

        RedemptionDisbursementInfo memory lenderRedemptionInfo = _getLastestDisbursementInfo(
            msg.sender,
            currentEpochId
        );
        lenderRedemptionInfo.numSharesRequested += uint96(shares);
        redemptionDisbursementInfoByLender[msg.sender] = lenderRedemptionInfo;

        ERC20Upgradeable._transfer(msg.sender, address(this), shares);

        emit RedemptionRequestAdded(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Cancels a previous redemption request of the specified number of shares.
     * @param shares The number of shares that the lender no longer wants to redeem
     */
    function cancelRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        uint256 currentEpochId = epochManager.currentEpochId();
        RedemptionDisbursementInfo memory lenderRedemptionInfo = _getLastestDisbursementInfo(
            msg.sender,
            currentEpochId
        );

        if (lenderRedemptionInfo.numSharesRequested < shares) {
            revert Errors.insufficientSharesForRequest();
        }

        lenderRedemptionInfo.numSharesRequested -= uint96(shares);
        redemptionDisbursementInfoByLender[msg.sender] = lenderRedemptionInfo;

        EpochInfo memory curEpochInfo = epochInfoByEpochId[currentEpochId];
        curEpochInfo.totalSharesRequested -= uint96(shares);
        epochInfoByEpochId[currentEpochId] = curEpochInfo;

        ERC20Upgradeable._transfer(address(this), msg.sender, shares);

        emit RedemptionRequestRemoved(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Transfers the full redeemable amount to the lender
     */
    function disburse(address receiver) external {
        poolConfig.onlyProtocolAndPoolOn();

        RedemptionDisbursementInfo memory info = _getLastestDisbursementInfo(msg.sender);
        uint256 withdrawable = info.totalAmountProcessed - info.totalAmountWithdrawn;
        if (withdrawable > 0) {
            underlyingToken.transfer(receiver, withdrawable);
            info.totalAmountWithdrawn += uint96(withdrawable);
            redemptionDisbursementInfoByLender[msg.sender] = info;
            emit LenderFundDisbursed(msg.sender, receiver, withdrawable);
        }
    }

    /**
     * @notice Returns the withdrawable assets value of the given account
     */
    function withdrawableAssets(address account) external view returns (uint256 assets) {
        RedemptionDisbursementInfo memory lenderRedemptionInfo = _getLastestDisbursementInfo(
            account
        );
        assets =
            lenderRedemptionInfo.totalAmountProcessed -
            lenderRedemptionInfo.totalAmountWithdrawn;
    }

    /**
     * @notice Returns the number of shares previously requested for redemption that can be cancelled.
     * @param account The lender's account
     */
    function cancellableRedemptionShares(address account) external view returns (uint256 shares) {
        RedemptionDisbursementInfo memory lenderRedemptionInfo = _getLastestDisbursementInfo(
            account
        );
        shares = lenderRedemptionInfo.numSharesRequested;
    }

    function totalAssets() public view returns (uint256) {
        return pool.trancheTotalAssets(trancheIndex);
    }

    function convertToShares(uint256 assets) external view returns (uint256 shares) {
        shares = _convertToShares(assets, totalAssets());
    }

    function convertToAssets(uint256 shares) public view returns (uint256 assets) {
        uint256 tempTotalAssets = totalAssets();
        uint256 tempTotalSupply = ERC20Upgradeable.totalSupply();
        return tempTotalSupply == 0 ? shares : (shares * tempTotalAssets) / tempTotalSupply;
    }

    function totalAssetsOf(address account) external view returns (uint256 assets) {
        return convertToAssets(ERC20Upgradeable.balanceOf(account));
    }

    function getNumEpochsWithRedemption() external view returns (uint256) {
        return epochIds.length;
    }

    function _convertToShares(
        uint256 _assets,
        uint256 _totalAssets
    ) internal view returns (uint256 shares) {
        // TODO solve the first tiny deposit vector - https://github.com/spearbit/portfolio/blob/master/pdfs/MapleV2.pdf

        uint256 supply = ERC20Upgradeable.totalSupply();

        return supply == 0 ? _assets : (_assets * supply) / _totalAssets;
    }

    function _updateUserWithdrawable(address user) internal returns (uint256 withdrawableAmount) {}

    function _getLastestDisbursementInfo(
        address account
    ) internal view returns (RedemptionDisbursementInfo memory lenderRedemptionInfo) {
        uint256 currentEpochId = epochManager.currentEpochId();
        lenderRedemptionInfo = _getLastestDisbursementInfo(account, currentEpochId);
    }

    function _getLastestDisbursementInfo(
        address account,
        uint256 currentEpochId
    ) internal view returns (RedemptionDisbursementInfo memory lenderRedemptionInfo) {
        lenderRedemptionInfo = redemptionDisbursementInfoByLender[account];
        if (lenderRedemptionInfo.indexOfEpochIds < epochIds.length) {
            uint256 epochId = epochIds[lenderRedemptionInfo.indexOfEpochIds];
            if (epochId < currentEpochId) {
                lenderRedemptionInfo = _calcLatestDisbursementInfo(lenderRedemptionInfo);
            }
        }
    }

    /**
     * @notice Calculates the amount of asset that the lender can withdraw.
     * @param disbursementInfo Information about the lender's last partially processed redemption request
     * @return newDisbursementInfo New information about the lender's last partially processed redemption request,
     */
    function _calcLatestDisbursementInfo(
        RedemptionDisbursementInfo memory disbursementInfo
    ) internal view returns (RedemptionDisbursementInfo memory newDisbursementInfo) {
        newDisbursementInfo = disbursementInfo;
        uint256 length = epochIds.length;
        uint256 remainingShares = newDisbursementInfo.numSharesRequested;
        if (remainingShares > 0) {
            for (
                uint256 i = newDisbursementInfo.indexOfEpochIds;
                i < length && remainingShares > 0;
                i++
            ) {
                uint256 epochId = epochIds[i];
                EpochInfo memory epoch = epochInfoByEpochId[epochId];
                if (epoch.totalSharesProcessed > 0) {
                    // TODO Will there be one decimal unit of rounding error here if it can't be divisible?
                    newDisbursementInfo.totalAmountProcessed += uint96(
                        (remainingShares * epoch.totalAmountProcessed) / epoch.totalSharesRequested
                    );
                    // TODO Round up here to be good for pool?
                    remainingShares -=
                        (remainingShares * epoch.totalSharesProcessed) /
                        epoch.totalSharesRequested;
                }
            }
            newDisbursementInfo.numSharesRequested = uint96(remainingShares);
        }
        newDisbursementInfo.indexOfEpochIds = uint64(length - 1);
    }

    function _onlyEpochManager(address account) internal view {
        if (account != address(epochManager)) revert Errors.notAuthorizedCaller();
    }

    function _onlyAuthorizedInitialDepositor(address account) internal view {
        if (account != poolConfig.poolOwnerTreasury() && account != poolConfig.evaluationAgent())
            revert Errors.notAuthorizedCaller();
    }

    function _onlyLender(address account) internal view {
        if (!hasRole(LENDER_ROLE, account)) revert Errors.permissionDeniedNotLender();
    }
}
