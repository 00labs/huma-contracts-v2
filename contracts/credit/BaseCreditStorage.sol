// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {CreditConfig, CreditRecord, CreditQuota, BorrowerQuota, PnLTracker} from "./CreditStructs.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {IPnLManager} from "./interfaces/IPnLManager.sol";
import {IPoolVault} from "../interfaces/IPoolVault.sol";

contract BaseCreditStorage {
    HumaConfig internal _humaConfig;

    // Reference to the fee manager contract
    ICreditFeeManager internal _feeManager;

    ICalendar public calendar;
    IPnLManager public pnlManager;
    IPoolVault public poolVault;

    PnLTracker public pnlTracker;

    mapping(address => CreditConfig) internal _borrowerConfigMap;
    /// mapping from credit id to the credit config
    mapping(bytes32 => CreditConfig) internal _creditConfigMap;
    /// mapping from credit id to the credit record
    mapping(bytes32 => CreditRecord) internal _creditRecordMap;
    mapping(bytes32 => CreditQuota) internal _creditQuotaMap;
    /// mapping from borrower to the credit limit at borrower-level
    mapping(address => BorrowerQuota) internal _borrowerQuotaMap;

    bytes32[] public activeCreditsHash;
    bytes32[] public overdueCreditsHash;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
