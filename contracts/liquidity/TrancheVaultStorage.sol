// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {EpochRedemptionSummary} from "./interfaces/IRedemptionHandler.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICalendar} from "../common/interfaces/ICalendar.sol";
import {HumaConfig} from "../common/HumaConfig.sol";

contract TrancheVaultStorage {
    struct LenderRedemptionRecord {
        // The next epoch ID fro redemption processing
        uint64 nextEpochIdToProcess;
        // The number of shares requested for redemption in this epoch
        uint96 numSharesRequested;
        // The principal amount included in the redemption request
        uint96 principalRequested;
        // The total amount processed for redemption in all epochs
        uint96 totalAmountProcessed;
        // The total amount withdrawn by the lender, the withdrawable amount = totalAmountProcessed - totalAmountWithdrawn
        uint96 totalAmountWithdrawn;
    }

    struct DepositRecord {
        // The total amount of underlying tokens deposited by the lender
        uint96 principal;
        // Whether the lender reinvests the yield
        bool reinvestYield;
        // The last deposit time in this pool
        uint64 lastDepositTime;
    }

    IERC20 public underlyingToken;
    uint8 internal _decimals;
    /// Senior or junior tranche index.
    uint8 public trancheIndex;

    HumaConfig public humaConfig;
    IPool public pool;
    IPoolSafe public poolSafe;
    IEpochManager public epochManager;
    ICalendar public calendar;

    /// Maps from epochId to the redemption summary for that epoch
    mapping(uint256 => EpochRedemptionSummary) public epochRedemptionSummaries;

    /// Maps from an account address to the redemption record for that lender
    mapping(address => LenderRedemptionRecord) public lenderRedemptionRecords;

    /// This mapping contains the amount of underlying tokens deposited by lenders
    mapping(address => DepositRecord) public depositRecords;

    /**
     * The list of lenders who wish to receive yield in each period instead of reinvesting them back
     * into the pool. The list is currently capped at 100.
     */
    address[] public nonReinvestingLenders;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
