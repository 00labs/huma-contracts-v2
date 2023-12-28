// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE, DEFAULT_DECIMALS_FACTOR, SECONDS_IN_A_DAY} from "./SharedDefs.sol";
import {TrancheVaultStorage, IERC20} from "./TrancheVaultStorage.sol";
import {IRedemptionHandler, EpochRedemptionSummary} from "./interfaces/IRedemptionHandler.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "hardhat/console.sol";

contract TrancheVault is
    AccessControlUpgradeable,
    ERC20Upgradeable,
    PoolConfigCache,
    TrancheVaultStorage,
    IRedemptionHandler
{
    bytes32 public constant LENDER_ROLE = keccak256("LENDER");
    uint256 private constant MAX_ALLOWED_NUM_LENDERS = 100;

    event EpochProcessed(
        uint256 indexed epochId,
        uint256 sharesRequested,
        uint256 sharesProcessed,
        uint256 amountProcessed
    );

    event LiquidityDeposited(
        address indexed sender,
        address indexed receiver,
        uint256 assetAmount,
        uint256 shareAmount
    );

    event LenderFundDisbursed(address indexed account, address receiver, uint256 withdrawnAmount);

    event RedemptionRequestAdded(address indexed account, uint256 shareAmount, uint256 epochId);

    event RedemptionRequestRemoved(address indexed account, uint256 shareAmount, uint256 epochId);

    event YieldPaidout(address indexed account, uint256 yields, uint256 shares);

    event YieldReinvested(address indexed account, uint256 yields);

    event ReinvestYieldConfigSet(address indexed account, bool reinvestYield, address by);

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
     * @notice Gets address for underlyingToken, pool, poolSafe, and epochManager from poolConfig
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
    function addApprovedLender(address lender, bool reinvestYield) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        if (hasRole(LENDER_ROLE, lender)) revert Errors.todo();

        _grantRole(LENDER_ROLE, lender);
        depositRecords[lender] = DepositRecord({
            principal: 0,
            reinvestYield: reinvestYield,
            lastDepositTime: 0
        });
        if (!reinvestYield) {
            if (nonReinvestingLenders.length >= MAX_ALLOWED_NUM_LENDERS) revert Errors.todo();
            nonReinvestingLenders.push(lender);
        }
    }

    /**
     * @notice Removes a lender. This prevents the lender from making more deposits.
     * The capital that the lender has contributed can continue to work as normal.
     */
    function removeApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        if (!hasRole(LENDER_ROLE, lender)) revert Errors.todo();
        _revokeRole(LENDER_ROLE, lender);
        if (!depositRecords[lender].reinvestYield) {
            _removeLenderFromNonReinvestingLenders(lender);
        }
        delete depositRecords[lender];
    }

    /**
     * @notice The pool operator will call this function to mark whether a lender wants to reinvest yield.
     */
    function setReinvestYield(address lender, bool reinvestYield) external {
        poolConfig.onlyPoolOperator(msg.sender);
        DepositRecord memory depositRecord = depositRecords[lender];
        if (depositRecord.reinvestYield == reinvestYield) revert Errors.todo();
        if (!depositRecord.reinvestYield && reinvestYield) {
            _removeLenderFromNonReinvestingLenders(lender);
        } else if (depositRecord.reinvestYield && !reinvestYield) {
            if (nonReinvestingLenders.length >= MAX_ALLOWED_NUM_LENDERS) revert Errors.todo();
            nonReinvestingLenders.push(lender);
        }
        depositRecord.reinvestYield = reinvestYield;
        depositRecords[lender] = depositRecord;
        emit ReinvestYieldConfigSet(lender, reinvestYield, msg.sender);
    }

    /// @inheritdoc IRedemptionHandler
    function currentRedemptionSummary()
        external
        view
        override
        returns (EpochRedemptionSummary memory redemptionSummary)
    {
        uint256 epochId = epochManager.currentEpochId();
        redemptionSummary = epochRedemptionSummaries[epochId];
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalSupply() public view override returns (uint256) {
        return ERC20Upgradeable.totalSupply();
    }

    /// @inheritdoc IRedemptionHandler
    function executeRedemptionSummary(EpochRedemptionSummary memory summaryProcessed) external {
        _onlyEpochManager(msg.sender);

        if (summaryProcessed.totalSharesProcessed > 0) {
            epochRedemptionSummaries[summaryProcessed.epochId] = summaryProcessed;
            // Burn processed shares of LP tokens.
            ERC20Upgradeable._burn(address(this), summaryProcessed.totalSharesProcessed);
            // Withdraw underlying tokens from the reserve so that LPs can redeem.
            poolSafe.withdraw(address(this), summaryProcessed.totalAmountProcessed);
        }

        uint256 unprocessed = summaryProcessed.totalSharesRequested -
            summaryProcessed.totalSharesProcessed;

        if (unprocessed > 0) {
            // Move unprocessed redemption to next epoch
            EpochRedemptionSummary memory nextRedemptionSummary = EpochRedemptionSummary({
                epochId: summaryProcessed.epochId + 1,
                totalSharesRequested: uint96(unprocessed),
                totalSharesProcessed: 0,
                totalAmountProcessed: 0
            });
            epochRedemptionSummaries[nextRedemptionSummary.epochId] = nextRedemptionSummary;
            epochIds.push(nextRedemptionSummary.epochId);
        }

        emit EpochProcessed(
            summaryProcessed.epochId,
            summaryProcessed.totalSharesRequested,
            summaryProcessed.totalSharesProcessed,
            summaryProcessed.totalAmountProcessed
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
     * @notice LP deposits to the pool to earn yield, and share losses
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
        uint256 availableCap = pool.getTrancheAvailableCap(trancheIndex);
        if (assets > availableCap) {
            revert Errors.trancheLiquidityCapExceeded();
        }

        poolSafe.deposit(msg.sender, assets);
        uint96[2] memory tranches = pool.currentTranchesAssets();
        uint256 trancheAssets = tranches[trancheIndex];
        shares = _convertToShares(assets, trancheAssets);
        ERC20Upgradeable._mint(receiver, shares);
        DepositRecord memory depositRecord = depositRecords[receiver];
        depositRecord.principal += uint96(assets);
        depositRecord.lastDepositTime = uint64(block.timestamp);
        depositRecords[receiver] = depositRecord;

        tranches[trancheIndex] += uint96(assets);
        pool.updateTranchesAssets(tranches);

        emit LiquidityDeposited(msg.sender, receiver, assets, shares);
    }

    /**
     * @notice Records a new redemption request.
     * @param shares The number of shares the lender wants to redeem
     */
    function addRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        DepositRecord memory depositRecord = depositRecords[msg.sender];
        if (
            block.timestamp <
            depositRecord.lastDepositTime +
                poolConfig.getLPConfig().withdrawalLockoutPeriodInDays *
                SECONDS_IN_A_DAY
        ) revert Errors.withdrawTooSoon();

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
        EpochRedemptionSummary memory currRedemptionSummary = epochRedemptionSummaries[
            currentEpochId
        ];
        if (currRedemptionSummary.totalSharesRequested > 0) {
            // If the current epoch already has redemption requests, then add the new redemption request
            // to it.
            currRedemptionSummary.totalSharesRequested += uint96(shares);
        } else {
            // Otherwise, record the current epoch ID in `epochIds` since there are now redemption requests,
            // and record the redemption request data in the global registry.
            epochIds.push(currentEpochId);
            currRedemptionSummary.epochId = uint64(currentEpochId);
            currRedemptionSummary.totalSharesRequested = uint96(shares);
        }
        epochRedemptionSummaries[currentEpochId] = currRedemptionSummary;

        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecord(
            msg.sender,
            currentEpochId
        );
        lenderRedemptionRecord.numSharesRequested += uint96(shares);
        uint256 principalRequested = convertToAssets(shares);
        lenderRedemptionRecord.principalRequested += uint96(principalRequested);
        lenderRedemptionRecords[msg.sender] = lenderRedemptionRecord;
        depositRecord.principal = uint96(
            depositRecord.principal > principalRequested
                ? depositRecord.principal - principalRequested
                : 0
        );
        depositRecords[msg.sender] = depositRecord;

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
        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecord(
            msg.sender,
            currentEpochId
        );

        if (lenderRedemptionRecord.numSharesRequested < shares) {
            revert Errors.insufficientSharesForRequest();
        }

        DepositRecord memory depositRecord = depositRecords[msg.sender];
        // TODO rounding error?
        depositRecord.principal +=
            (lenderRedemptionRecord.principalRequested * uint96(shares)) /
            lenderRedemptionRecord.numSharesRequested;
        depositRecords[msg.sender] = depositRecord;

        uint96 newNumSharesRequested = lenderRedemptionRecord.numSharesRequested - uint96(shares);
        // TODO rounding error?
        lenderRedemptionRecord.principalRequested =
            (lenderRedemptionRecord.principalRequested * newNumSharesRequested) /
            lenderRedemptionRecord.numSharesRequested;
        lenderRedemptionRecord.numSharesRequested = newNumSharesRequested;
        lenderRedemptionRecords[msg.sender] = lenderRedemptionRecord;

        EpochRedemptionSummary memory currRedemptionSummary = epochRedemptionSummaries[
            currentEpochId
        ];
        currRedemptionSummary.totalSharesRequested -= uint96(shares);
        epochRedemptionSummaries[currentEpochId] = currRedemptionSummary;

        ERC20Upgradeable._transfer(address(this), msg.sender, shares);

        emit RedemptionRequestRemoved(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Transfers the full redeemable amount to the lender
     */
    function disburse() external {
        poolConfig.onlyProtocolAndPoolOn();

        LenderRedemptionRecord memory record = _getLatestLenderRedemptionRecordFor(msg.sender);
        uint256 withdrawable = record.totalAmountProcessed - record.totalAmountWithdrawn;
        if (withdrawable > 0) {
            record.totalAmountWithdrawn += uint96(withdrawable);
            lenderRedemptionRecords[msg.sender] = record;
            underlyingToken.transfer(msg.sender, withdrawable);
            emit LenderFundDisbursed(msg.sender, msg.sender, withdrawable);
        }
    }

    /**
     * @notice Process yield of lenders, pay out yield to lenders who want to withdraw
     * reinvest yield for lenders who want to reinvest. Expects to be called by a cron-like mechanism like autotask.
     */
    function processYieldForLenders() external {
        uint256 len = nonReinvestingLenders.length;

        uint256 price = convertToAssets(DEFAULT_DECIMALS_FACTOR);
        uint96[2] memory tranchesAssets = pool.currentTranchesAssets();
        for (uint256 i; i < len; i++) {
            address lender = nonReinvestingLenders[i];
            uint256 shares = ERC20Upgradeable.balanceOf(lender);
            uint256 assets = (shares * price) / DEFAULT_DECIMALS_FACTOR;
            DepositRecord memory depositRecord = depositRecords[lender];
            if (assets > depositRecord.principal) {
                uint256 yield = assets - depositRecord.principal;
                // TODO rounding up?
                shares = (yield * DEFAULT_DECIMALS_FACTOR) / price;
                if (shares > 0) {
                    ERC20Upgradeable._burn(lender, shares);
                    poolSafe.withdraw(lender, yield);
                    tranchesAssets[trancheIndex] -= uint96(yield);
                    emit YieldPaidout(lender, yield, shares);
                }
            }
        }
        poolSafe.resetUnprocessedProfit();
        pool.updateTranchesAssets(tranchesAssets);
    }

    /**
     * @notice Disables transfer function currently, need to consider how to support it later(lender permission,
     * yield payout, profit distribution, etc.) when integrating with DEXs.
     */
    function transfer(address, uint256) public virtual override returns (bool) {
        revert Errors.unsupportedFunction();
    }

    /**
     * @notice Returns the withdrawable assets value of the given account
     */
    function withdrawableAssets(address account) external view returns (uint256 assets) {
        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecordFor(
            account
        );
        assets =
            lenderRedemptionRecord.totalAmountProcessed -
            lenderRedemptionRecord.totalAmountWithdrawn;
    }

    /**
     * @notice Returns the number of shares previously requested for redemption that can be cancelled.
     * @param account The lender's account
     */
    function cancellableRedemptionShares(address account) external view returns (uint256 shares) {
        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecordFor(
            account
        );
        shares = lenderRedemptionRecord.numSharesRequested;
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

    function getNonReinvestingLendersLength() external view returns (uint256) {
        return nonReinvestingLenders.length;
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

    function _getLatestLenderRedemptionRecordFor(
        address account
    ) internal view returns (LenderRedemptionRecord memory lenderRedemptionRecord) {
        uint256 currentEpochId = epochManager.currentEpochId();
        lenderRedemptionRecord = _getLatestLenderRedemptionRecord(account, currentEpochId);
    }

    function _getLatestLenderRedemptionRecord(
        address account,
        uint256 currentEpochId
    ) internal view returns (LenderRedemptionRecord memory lenderRedemptionRecord) {
        lenderRedemptionRecord = lenderRedemptionRecords[account];
        if (lenderRedemptionRecord.lastUpdatedEpochIndex < epochIds.length) {
            uint256 epochId = epochIds[lenderRedemptionRecord.lastUpdatedEpochIndex];
            if (epochId < currentEpochId) {
                lenderRedemptionRecord = _updateLenderRedemptionRecord(lenderRedemptionRecord);
            }
        }
    }

    /**
     * @notice Brings the redemption record for a lender up-to-date.
     * @dev Prior to invoking this function, the lender's redemption record may be outdated, not accurately reflecting
     * the amount of withdrawable funds. This is due to the potential passage of additional epochs and the
     * processing of further redemption requests since the lender's last update. This function addresses this
     * by iterating through all epochs executed since the last update, ensuring the redemption record is current
     * and accurate.
     * @param redemptionRecord The lender's current processed redemption request record.
     * @return newRedemptionRecord The lender's updated processed redemption request record.
     */
    function _updateLenderRedemptionRecord(
        LenderRedemptionRecord memory redemptionRecord
    ) internal view returns (LenderRedemptionRecord memory newRedemptionRecord) {
        newRedemptionRecord = redemptionRecord;
        uint256 numEpochIds = epochIds.length;
        uint256 remainingShares = newRedemptionRecord.numSharesRequested;
        if (remainingShares > 0) {
            uint256 totalShares = remainingShares;
            for (
                uint256 i = newRedemptionRecord.lastUpdatedEpochIndex;
                i < numEpochIds && remainingShares > 0;
                i++
            ) {
                uint256 epochId = epochIds[i];
                EpochRedemptionSummary memory summary = epochRedemptionSummaries[epochId];
                if (summary.totalSharesProcessed > 0) {
                    // TODO Will there be one decimal unit of rounding error here if it can't be divisible?
                    newRedemptionRecord.totalAmountProcessed += uint96(
                        (remainingShares * summary.totalAmountProcessed) /
                            summary.totalSharesRequested
                    );
                    // TODO Round up here to be good for pool?
                    remainingShares -=
                        (remainingShares * summary.totalSharesProcessed) /
                        summary.totalSharesRequested;
                }
            }
            newRedemptionRecord.numSharesRequested = uint96(remainingShares);
            if (remainingShares < totalShares) {
                // Some shares are processed, so the principal requested is reduced proportionally.
                newRedemptionRecord.principalRequested = uint96(
                    (remainingShares * newRedemptionRecord.principalRequested) / totalShares
                );
            }
        }
        newRedemptionRecord.lastUpdatedEpochIndex = uint64(numEpochIds - 1);
    }

    function _removeLenderFromNonReinvestingLenders(address lender) internal {
        uint256 len = nonReinvestingLenders.length;
        for (uint256 i; i < len; i++) {
            if (nonReinvestingLenders[i] == lender) {
                if (i != len - 1) nonReinvestingLenders[i] = nonReinvestingLenders[len - 1];
                nonReinvestingLenders.pop();
                break;
            }
        }
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
