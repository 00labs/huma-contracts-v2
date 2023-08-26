// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HumaConfig} from "../HumaConfig.sol";
import {CreditConfig, CreditRecord, CreditLimits, PnLTracker} from "./CreditStructs.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";

contract BaseCreditStorage {
    // The ERC20 token this pool manages
    IERC20 internal _underlyingToken;

    PoolConfig internal _poolConfig;

    HumaConfig internal _humaConfig;

    // Reference to the fee manager contract
    ICreditFeeManager internal _feeManager;

    PnLTracker public pnlTracker;

    mapping(address => CreditConfig) internal _borrowerConfigMap;
    /// mapping from credit id to the credit config
    mapping(bytes32 => CreditConfig) internal _creditConfigMap;
    /// mapping from credit id to the credit record
    mapping(bytes32 => CreditRecord) internal _creditRecordMap;
    /// mapping from borrower to the credit limit at borrower-level
    mapping(address => CreditLimits) internal _creditLimitsMap;

    bytes32[] public activeCreditsHash;
    bytes32[] public overdueCreditsHash;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
